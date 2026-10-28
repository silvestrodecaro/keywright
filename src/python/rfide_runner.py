"""Robot Framework helpers used by the IDE. Runs with the project's Python.

* ``python rfide_runner.py discover <path>`` prints the suite/test tree as JSON.
* ``python rfide_runner.py index <project root>`` prints the library/resource
  imports and the user keywords of every .robot/.resource file as JSON.
* ``python rfide_runner.py libdoc <library>...`` prints library keywords as JSON.
* ``python rfide_runner.py serve`` answers editor requests (syntax check of
  unsaved content) as JSON lines on stdin/stdout.
* ``--listener rfide_runner.Listener`` streams execution events as JSON lines
  to the TCP port in the ``RFIDE_PORT`` environment variable. With
  ``RFIDE_DEBUG=1`` it also reads debugger commands from that connection and
  pauses at the breakpoints in ``RFIDE_BREAKPOINTS`` (JSON {source: [lines]}).
* ``--prerunmodifier rfide_runner.SelectTests`` keeps only the tests whose full
  name, or the full name of one of their suites, is in the JSON list in
  ``RFIDE_SELECT``.

Suites and tests are identified by their full name (``Tests.Login.Valid User``):
Robot's own ids (``s1-s2-t1``) are positional and change when tests are filtered.
"""

import json
import os
import queue
import re
import socket
import sys
import threading

from robot.api import SuiteVisitor, TestSuiteBuilder

MAX_TEXT = 4000
# Logged by the Browser library's New Context when tracing is enabled.
TRACE_MESSAGE = re.compile(r"trace file will be saved to: (.+\.zip)\s*$", re.IGNORECASE)


def _rel(path, root):
    if not path:
        return None
    try:
        return os.path.relpath(str(path), root).replace(os.sep, "/")
    except ValueError:  # different drive on Windows
        return str(path)


def _suite_to_dict(suite, root):
    return {
        "id": suite.full_name,
        "name": suite.name,
        "source": _rel(suite.source, root),
        "suites": [_suite_to_dict(child, root) for child in suite.suites],
        "tests": [
            {
                "id": test.full_name,
                "name": test.name,
                "lineno": test.lineno,
                "tags": list(test.tags),
                "source": _rel(test.source, root),
            }
            for test in suite.tests
        ],
    }


def discover(path, root):
    suite = TestSuiteBuilder().build(path)
    return _suite_to_dict(suite, root)


class SelectTests(SuiteVisitor):
    """Pre-run modifier keeping only the selected tests and suites."""

    def __init__(self):
        self.names = set(json.loads(os.environ.get("RFIDE_SELECT") or "[]"))

    def start_suite(self, suite):
        if not self.names or self._selected(suite):
            return
        suite.tests = [test for test in suite.tests if test.full_name in self.names]

    def _selected(self, suite):
        while suite is not None:
            if suite.full_name in self.names:
                return True
            suite = suite.parent
        return False

    def end_suite(self, suite):
        suite.suites = [child for child in suite.suites if child.test_count > 0]

    def visit_test(self, test):
        pass


def _seconds(result):
    elapsed = getattr(result, "elapsed_time", None)
    return elapsed.total_seconds() if elapsed is not None else None


def _truncate(text):
    text = str(text)
    return text if len(text) <= MAX_TEXT else text[:MAX_TEXT] + " …"


def _describe(result):
    """Short label for a body item (keyword call or control structure)."""
    kind = result.type
    if kind in ("KEYWORD", "SETUP", "TEARDOWN"):
        return {"kind": kind.lower(), "name": result.name or "", "args": [_truncate(a) for a in result.args],
                "assign": list(result.assign)}
    if kind == "FOR":
        text = "FOR    " + "    ".join([*result.assign, result.flavor, *result.values])
    elif kind in ("IF", "ELSE IF"):
        text = f"{kind}    {result.condition}"
    elif kind == "WHILE":
        text = f"WHILE    {result.condition or ''}"
    elif kind == "ITERATION":
        assign = getattr(result, "assign", None) or {}
        text = "    ".join(f"{name} = {value}" for name, value in assign.items()) or "ITERATION"
    elif kind == "VAR":
        text = f"VAR    {result.name}    {'    '.join(result.value)}"
    elif kind == "RETURN":
        text = "RETURN    " + "    ".join(result.values)
    elif kind == "EXCEPT":
        text = "EXCEPT    " + "    ".join(result.patterns)
    else:
        text = kind
    return {"kind": kind.lower(), "name": _truncate(text.strip()), "args": [], "assign": []}


# Body items the debugger stops at (not FOR iterations nor IF/TRY branches).
PAUSABLE = {"KEYWORD", "SETUP", "TEARDOWN", "FOR", "WHILE", "IF/ELSE ROOT", "TRY/EXCEPT ROOT", "VAR", "RETURN",
            "BREAK", "CONTINUE", "GROUP"}
BUILTIN_VARIABLES = {"/", ":", "\\n", "space", "empty", "true", "false", "none", "null", "curdir", "tempdir", "execdir",
                     "options", "outputdir", "outputfile", "logfile", "reportfile", "debugfile", "loglevel",
                     "prevtestname", "prevteststatus", "prevtestmessage", "suitename", "suitesource",
                     "suitedocumentation", "suitemetadata", "suitestatus", "suitemessage", "testname",
                     "testdocumentation", "testtags", "testmetadata", "teststatus", "testmessage", "keywordstatus",
                     "keywordmessage"}


# Keywords that run others expecting them to fail: failures inside are not stopped at.
EXPECTED_FAILURES = {"runkeywordandignoreerror", "runkeywordandreturnstatus", "runkeywordandexpecterror",
                     "waituntilkeywordsucceeds", "runkeywordandwarnonfailure"}
SINGLE_VARIABLE = re.compile(r"^[$@&%]\{.+\}(\[[^\]]*\])*$")


def _normalize_source(path):
    # realpath: Windows 8.3 short names (NAME~1) and symlinks give the same key as Robot's paths.
    return os.path.normcase(os.path.realpath(path)) if path else None


def _source(data):
    """The file of a body item, as text (Robot gives a Path)."""
    source = getattr(data, "source", None)
    return str(source) if source else None


def _variable_key(name):
    return name[2:-1].lower().replace(" ", "").replace("_", "")


def _value(value):
    text = value if isinstance(value, str) else repr(value)
    return {"value": _truncate(text), "type": type(value).__name__}


class Debugger:
    """Breakpoints, stepping, stop on failure and evaluation while paused.
    Commands arrive on the listener's connection."""

    def __init__(self, listener, sock):
        self._listener = listener
        self._commands = queue.Queue()
        self._breakpoints = self._parse(json.loads(os.environ.get("RFIDE_BREAKPOINTS") or "{}"))
        self._pause_on_failure = os.environ.get("RFIDE_PAUSE_ON_FAILURE") == "1"
        self._mode = None  # None (run to breakpoints), "pause", "into", "over", "out"
        self._depth = 0  # body item depth of the last pause, for stepping
        self._failure_stopped = False  # stopped at a failure: its parents fail too, do not stop again
        threading.Thread(target=self._read, args=(sock,), daemon=True).start()

    @staticmethod
    def _parse(breakpoints):
        return {(_normalize_source(source), int(line)) for source, lines in breakpoints.items() for line in lines}

    def _read(self, sock):
        try:
            for line in sock.makefile("r", encoding="utf-8"):
                if line.strip():
                    self._commands.put(json.loads(line))
        except (OSError, ValueError):
            pass
        self._commands.put({"command": "detach"})  # the IDE went away: never block again

    def _handle(self, command):
        """Applies a command; returns True when it resumes execution."""
        name = command.get("command")
        if name == "breakpoints":
            self._breakpoints = self._parse(command.get("breakpoints") or {})
        elif name == "options":
            self._pause_on_failure = bool(command.get("pauseOnFailure"))
        elif name == "evaluate":
            self._listener._send({"type": "debug-evaluated", "id": command.get("id"),
                                  **self._evaluate(command.get("expression") or "", command.get("keywords", True))})
        elif name == "pause":
            self._mode = "pause"
        elif name == "detach":
            self._breakpoints = set()
            self._mode = None
            return True
        elif name in ("continue", "into", "over", "out"):
            self._mode = None if name == "continue" else name
            return True
        return False

    def _poll(self):
        while True:
            try:
                self._handle(self._commands.get_nowait())
            except queue.Empty:
                break

    def before(self, data, result, depth, frames):
        """Called before each body item runs; blocks while paused."""
        self._poll()
        self._failure_stopped = False
        if result.type not in PAUSABLE:
            return
        source = _normalize_source(getattr(data, "source", None))
        lineno = getattr(data, "lineno", None)
        mode = self._mode
        if (source, lineno) in self._breakpoints:
            reason = "breakpoint"
        elif mode in ("pause", "into") or (mode == "over" and depth <= self._depth) or (mode == "out" and depth < self._depth):
            reason = "step" if mode != "pause" else "pause"
        else:
            return
        current = {"name": _describe(result)["name"], "source": _source(data), "lineno": lineno}
        self._pause(reason, data, result, depth, [current, *reversed(frames)])

    def after(self, data, result, depth, frames, ancestors):
        """Called when a body item ends; stops at the innermost failure that is not expected."""
        if (not self._pause_on_failure or self._failure_stopped or result.status != "FAIL"
                or result.type not in ("KEYWORD", "SETUP", "TEARDOWN")):
            return
        self._failure_stopped = True
        if any(kind == "TRY" or name.lower().replace(" ", "").replace("_", "") in EXPECTED_FAILURES
               for kind, name in ancestors):
            return
        self._poll()
        self._pause("failure", data, result, depth, list(reversed(frames)), message=_truncate(result.message))

    def _pause(self, reason, data, result, depth, frames, message=None):
        self._depth = depth
        self._listener._send({"type": "debug-paused", "reason": reason, "message": message,
                              "test": self._listener._test, "suite": self._listener._suite(),
                              "source": _source(data), "lineno": getattr(data, "lineno", None), "step": result.id,
                              **_describe(result), "frames": frames, "variables": self._variables()})
        while not self._handle(self._commands.get()):
            pass
        self._listener._send({"type": "debug-resumed"})

    def _evaluate(self, expression, keywords=True):
        """A variable (${x}[0], ${obj.attr}), a keyword call (cells separated by two spaces) or a
        Python expression as in Evaluate ($x for variables). Events of keywords run here are muted."""
        from robot.libraries.BuiltIn import BuiltIn
        from robot.running.context import EXECUTION_CONTEXTS

        context = EXECUTION_CONTEXTS.current
        text = expression.strip()
        if context is None or not text:
            return {"ok": False, "error": "Nothing to evaluate."}
        self._listener._muted = True
        try:
            if SINGLE_VARIABLE.match(text):
                value = context.variables.replace_scalar(text)
            else:
                cells = [cell for cell in re.split(r"\s{2,}|\t", text) if cell]
                runner = context.namespace.get_runner(cells[0], recommend_on_failure=False)
                if type(runner).__name__ != "InvalidKeywordRunner":
                    if not keywords:
                        return {"ok": False, "error": "Watches do not run keywords: evaluate it from the input instead."}
                    value = BuiltIn().run_keyword(cells[0], *cells[1:])
                else:
                    value = BuiltIn().evaluate(text)
            described = _value(value)  # "type" would clash with the event type
            return {"ok": True, "value": described["value"], "valueType": described["type"]}
        except Exception as error:
            return {"ok": False, "error": _truncate(str(error) or type(error).__name__)}
        finally:
            self._listener._muted = False

    def _variables(self):
        """Visible variables grouped by the innermost scope defining them: Local, Test, Suite, Global."""
        from robot.running.context import EXECUTION_CONTEXTS

        context = EXECUTION_CONTEXTS.current
        if context is None:
            return []
        scopes = context.variables
        layers = [("Local", scopes.current), ("Test", scopes._test), ("Suite", scopes._suite), ("Global", scopes._global)]
        dicts = []
        for name, store in layers:
            if store is None or any(store is other for _, other, _ in dicts):
                continue
            # Outside keywords the current scope is the test's (or the suite's): name it after that one.
            if name == "Local" and (store is scopes._test or store is scopes._suite):
                continue
            dicts.append((name, store, store.as_dict(decoration=True)))
        groups = []
        for index, (name, _, values) in enumerate(dicts):
            outer = dicts[index + 1][2] if index + 1 < len(dicts) else {}
            items = [{"name": key, **_value(value)} for key, value in values.items()
                     if _variable_key(key) not in BUILTIN_VARIABLES and (key not in outer or outer[key] is not value)]
            if items:
                groups.append({"scope": name, "variables": sorted(items, key=lambda item: item["name"].lower())})
        return groups


class Listener:
    ROBOT_LISTENER_API_VERSION = 3

    def __init__(self):
        self._socket = None
        self._stack = []  # ids of running body items, for attaching log messages
        self._frames = []  # running keyword calls (name, source, lineno), for the debugger's call stack
        self._kinds = []  # (type, name) of the running body items, to recognize expected failures
        self._muted = False  # the debugger is running keywords for an evaluation
        self._test = None
        self._suites = []  # full names of the running suites
        self._debugger = None
        port = os.environ.get("RFIDE_PORT")
        if port:
            try:
                self._socket = socket.create_connection(("127.0.0.1", int(port)), timeout=5)
                self._socket.settimeout(None)  # the debugger waits for commands
            except OSError as error:
                print(f"[rfide] cannot connect to the IDE: {error}", file=sys.__stderr__)
        if self._socket and os.environ.get("RFIDE_DEBUG") == "1":
            self._debugger = Debugger(self, self._socket)

    def _send(self, event):
        if not self._socket:
            return
        try:
            self._socket.sendall((json.dumps(event) + "\n").encode("utf-8"))
        except OSError:
            self._socket = None

    def start_suite(self, data, result):
        self._suites.append(result.full_name)
        self._stack = []
        self._frames = []
        self._kinds = []
        self._send({"type": "suite-start", "id": result.full_name, "name": result.name})

    def end_suite(self, data, result):
        # A failing suite teardown fails the suite's tests after their end_test.
        if result.has_teardown and result.teardown.failed:
            for test in result.all_tests:
                self._send({"type": "test-end", "id": test.full_name, "status": test.status,
                            "message": _truncate(test.message), "elapsed": _seconds(test)})
        self._send({"type": "suite-end", "id": result.full_name, "status": result.status,
                    "message": _truncate(result.message), "elapsed": _seconds(result)})
        if self._suites:
            self._suites.pop()

    def start_test(self, data, result):
        self._test = result.full_name
        self._stack = []
        self._frames = []
        self._kinds = []
        self._send({"type": "test-start", "id": result.full_name, "name": result.name})

    def end_test(self, data, result):
        self._send({"type": "test-end", "id": result.full_name, "status": result.status,
                    "message": _truncate(result.message), "elapsed": _seconds(result)})
        self._test = None

    def _suite(self):
        """The running suite, for steps of suite setups and teardowns (outside tests)."""
        return self._suites[-1] if self._suites else None

    def start_body_item(self, data, result):
        if self._muted:
            return
        if self._debugger:
            self._debugger.before(data, result, len(self._stack), self._frames)
        item_id = result.id
        parent = self._stack[-1] if self._stack else None
        self._stack.append(item_id)
        self._kinds.append((result.type, result.name if result.type in ("KEYWORD", "SETUP", "TEARDOWN") else ""))
        if result.type in ("KEYWORD", "SETUP", "TEARDOWN"):
            self._frames.append({"name": result.name or "", "source": _source(data),
                                 "lineno": getattr(data, "lineno", None), "id": item_id})
        self._send({"type": "step-start", "id": item_id, "parent": parent, "test": self._test, "suite": self._suite(),
                    "lineno": getattr(data, "lineno", None), **_describe(result)})

    def end_body_item(self, data, result):
        if self._muted:
            return
        if self._debugger and self._stack and self._stack[-1] == result.id:
            self._debugger.after(data, result, len(self._stack) - 1, self._frames, self._kinds[:-1])
        if self._stack and self._stack[-1] == result.id:
            self._stack.pop()
            self._kinds.pop()
        if self._frames and self._frames[-1]["id"] == result.id:
            self._frames.pop()
        self._send({"type": "step-end", "id": result.id, "test": self._test, "suite": self._suite(), "status": result.status,
                    "message": _truncate(getattr(result, "message", "") or ""), "elapsed": _seconds(result)})

    def log_message(self, message):
        if self._muted:
            return
        trace = TRACE_MESSAGE.search(message.message or "")
        if trace:
            # The trace belongs to the test, or to the suite when the context is
            # created in a suite setup; the file is written when the context closes.
            self._send({"type": "trace", "test": self._test, "suite": self._suites[-1] if self._suites else None,
                        "path": trace.group(1).strip()})
        self._send({"type": "log", "step": self._stack[-1] if self._stack else None, "test": self._test, "suite": self._suite(),
                    "level": message.level, "html": bool(message.html), "text": _truncate(message.message),
                    "timestamp": message.timestamp.isoformat() if message.timestamp else None})

    def close(self):
        self._send({"type": "close"})
        if self._socket:
            try:
                self._socket.close()
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Keyword index for the editor (completion and hover)

SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", "results"}


def _args(spec):
    return [{"name": arg.name, "repr": str(arg), "required": arg.required, "kind": arg.kind} for arg in spec]


def _project_files(root):
    for directory, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
        for name in sorted(files):
            if name.lower().endswith((".robot", ".resource")):
                yield os.path.join(directory, name)


def project_index(root):
    from robot.running import ResourceFile, TestSuite

    libraries, keywords, errors = {"BuiltIn"}, [], []
    for path in _project_files(root):
        try:
            if path.lower().endswith(".resource"):
                resource = ResourceFile.from_file_system(path)
            else:
                resource = TestSuite.from_file_system(path).resource
        except Exception as error:
            errors.append({"source": _rel(path, root), "error": str(error)})
            continue
        for item in resource.imports:
            if item.type == "LIBRARY":
                name = item.name
                if name.lower().endswith(".py") or "/" in name or "\\" in name:
                    name = os.path.normpath(os.path.join(os.path.dirname(path), name))
                libraries.add(name)
        for kw in resource.keywords:
            keywords.append({
                "name": kw.name,
                "args": _args(kw.args),
                "shortdoc": kw.short_doc,
                "doc": kw.doc,
                "source": _rel(path, root),
                "lineno": kw.lineno,
                "library": os.path.splitext(os.path.basename(path))[0],
            })
    return {"libraries": sorted(libraries), "keywords": keywords, "errors": errors}


def libdoc(name):
    from robot.libdocpkg import LibraryDocumentation

    doc = LibraryDocumentation(name)
    try:
        doc.convert_docs_to_html()
    except Exception:  # e.g. Markdown docs without the 'markdown' module: keep the source format
        pass
    return {
        "name": doc.name,
        "version": doc.version,
        "docFormat": doc.doc_format,
        "keywords": [
            {"name": kw.name, "args": _args(kw.args), "shortdoc": kw.short_doc, "doc": kw.doc, "library": doc.name}
            for kw in doc.keywords
        ],
    }


# ---------------------------------------------------------------------------
# Syntax check for the editor

def _problem(start_line, start_col, end_line, end_col, message, severity="error"):
    return {"line": start_line, "column": start_col + 1, "endLine": end_line,
            "endColumn": max(end_col, start_col + 1) + 1, "message": message, "severity": severity}


def check(text, path=""):
    """Parsing errors of unsaved file content, as editor markers (1-based)."""
    from robot.api import (get_init_model, get_init_tokens, get_model, get_resource_model,
                           get_resource_tokens, get_tokens)
    from robot.parsing.model.visitor import ModelVisitor

    name = os.path.basename(path).lower()
    if name.endswith(".resource"):
        get, tokenize = get_resource_model, get_resource_tokens
    elif name.startswith("__init__."):
        get, tokenize = get_init_model, get_init_tokens
    else:
        get, tokenize = get_model, get_tokens
    problems = []
    for token in tokenize(text, data_only=False):
        if token.error:
            problems.append(_problem(token.lineno, token.col_offset, token.lineno, token.end_col_offset, token.error))

    class Collector(ModelVisitor):
        def generic_visit(self, node):
            errors = getattr(node, "errors", None) or ()
            # `Error` statements are already reported with their tokens.
            if errors and type(node).__name__ != "Error":
                target = getattr(node, "header", None) or node
                tokens = list(getattr(target, "data_tokens", None) or getattr(target, "tokens", []))
                if tokens:
                    first, last = tokens[0], tokens[-1]
                    position = (first.lineno, first.col_offset, last.lineno, last.end_col_offset)
                else:
                    position = (node.lineno, 0, node.lineno, 1)
                for message in errors:
                    problems.append(_problem(*position, message))
            super().generic_visit(node)

    Collector().visit(get(text))
    unique = {(p["line"], p["column"], p["message"]): p for p in problems}
    return sorted(unique.values(), key=lambda p: (p["line"], p["column"]))


def serve():
    """Answers JSON requests, one per line on stdin: {"id", "command", ...}."""
    commands = {"check": lambda request: {"problems": check(request["text"], request.get("path", ""))}}
    for line in sys.stdin:
        if not line.strip():
            continue
        request = {}
        try:
            request = json.loads(line)
            response = {"id": request.get("id"), "ok": True, **commands[request["command"]](request)}
        except Exception as error:  # keep serving after a bad request
            response = {"id": request.get("id"), "ok": False, "error": str(error)}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


def _main(argv):
    command = argv[1] if len(argv) > 1 else None
    if command == "discover" and len(argv) >= 3:
        target = os.path.abspath(argv[2])
        root = os.path.abspath(argv[3]) if len(argv) > 3 else os.path.dirname(target)
        return {"ok": True, "suite": discover(target, root)}
    if command == "index" and len(argv) == 3:
        return {"ok": True, **project_index(os.path.abspath(argv[2]))}
    if command == "libdoc" and len(argv) >= 3:
        libraries, errors = [], []
        for name in argv[2:]:
            try:
                libraries.append({"import": name, **libdoc(name)})
            except Exception as error:
                errors.append({"import": name, "error": str(error).splitlines()[0]})
        return {"ok": True, "libraries": libraries, "errors": errors}
    print("usage: rfide_runner.py discover <path> [root] | index <root> | libdoc <library>...", file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    if sys.argv[1:] == ["serve"]:
        serve()
        sys.exit(0)
    try:
        result = _main(sys.argv)
    except Exception as error:  # report data errors to the IDE instead of crashing
        result = {"ok": False, "error": str(error)}
    # Library imports may print to stdout: the JSON result is always the last line.
    print()
    print(json.dumps(result))
