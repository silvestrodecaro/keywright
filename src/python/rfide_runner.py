"""Robot Framework helpers used by the IDE. Runs with the project's Python.

* ``python rfide_runner.py discover <path>`` prints the suite/test tree as JSON.
* ``python rfide_runner.py index <project root>`` prints the library/resource
  imports and the user keywords of every .robot/.resource file as JSON.
* ``python rfide_runner.py libdoc <library>...`` prints library keywords as JSON.
* ``python rfide_runner.py serve`` answers editor requests (syntax check of
  unsaved content) as JSON lines on stdin/stdout.
* ``--listener rfide_runner.Listener`` streams execution events as JSON lines
  to the TCP port in the ``RFIDE_PORT`` environment variable.
* ``--prerunmodifier rfide_runner.SelectTests`` keeps only the tests whose full
  name, or the full name of one of their suites, is in the JSON list in
  ``RFIDE_SELECT``.

Suites and tests are identified by their full name (``Tests.Login.Valid User``):
Robot's own ids (``s1-s2-t1``) are positional and change when tests are filtered.
"""

import json
import os
import re
import socket
import sys

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


class Listener:
    ROBOT_LISTENER_API_VERSION = 3

    def __init__(self):
        self._socket = None
        self._stack = []  # ids of running body items, for attaching log messages
        self._test = None
        self._suites = []  # full names of the running suites
        port = os.environ.get("RFIDE_PORT")
        if port:
            try:
                self._socket = socket.create_connection(("127.0.0.1", int(port)), timeout=5)
            except OSError as error:
                print(f"[rfide] cannot connect to the IDE: {error}", file=sys.__stderr__)

    def _send(self, event):
        if not self._socket:
            return
        try:
            self._socket.sendall((json.dumps(event) + "\n").encode("utf-8"))
        except OSError:
            self._socket = None

    def start_suite(self, data, result):
        self._suites.append(result.full_name)
        self._send({"type": "suite-start", "id": result.full_name, "name": result.name})

    def end_suite(self, data, result):
        self._send({"type": "suite-end", "id": result.full_name, "status": result.status,
                    "message": _truncate(result.message), "elapsed": _seconds(result)})
        if self._suites:
            self._suites.pop()

    def start_test(self, data, result):
        self._test = result.full_name
        self._stack = []
        self._send({"type": "test-start", "id": result.full_name, "name": result.name})

    def end_test(self, data, result):
        self._send({"type": "test-end", "id": result.full_name, "status": result.status,
                    "message": _truncate(result.message), "elapsed": _seconds(result)})
        self._test = None

    def start_body_item(self, data, result):
        item_id = result.id
        parent = self._stack[-1] if self._stack else None
        self._stack.append(item_id)
        self._send({"type": "step-start", "id": item_id, "parent": parent, "test": self._test,
                    "lineno": getattr(data, "lineno", None), **_describe(result)})

    def end_body_item(self, data, result):
        if self._stack and self._stack[-1] == result.id:
            self._stack.pop()
        self._send({"type": "step-end", "id": result.id, "test": self._test, "status": result.status,
                    "message": _truncate(getattr(result, "message", "") or ""), "elapsed": _seconds(result)})

    def log_message(self, message):
        trace = TRACE_MESSAGE.search(message.message or "")
        if trace:
            # The trace belongs to the test, or to the suite when the context is
            # created in a suite setup; the file is written when the context closes.
            self._send({"type": "trace", "test": self._test, "suite": self._suites[-1] if self._suites else None,
                        "path": trace.group(1).strip()})
        self._send({"type": "log", "step": self._stack[-1] if self._stack else None, "test": self._test,
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
