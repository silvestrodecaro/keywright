# Security policy

## Supported versions

Keywright runs from source. Security fixes are made on the `main` branch and
included in the next tagged version; earlier versions are not patched. Update your checkout as described in
[updates and local settings](docs/user-guide.md#updates-and-local-settings) before
reporting a problem.

## Reporting a vulnerability

Report vulnerabilities privately through the repository's
[security advisories](https://github.com/silvestrodecaro/keywright/security/advisories/new)
page (**Security → Report a vulnerability**). Do not open a public issue for them.
If you cannot use that page, email inquire.silvestro@gmail.com.

Include:

- the Keywright commit or version, Windows version, Node.js and Python versions;
- the steps or a small project that reproduces the problem;
- what an attacker can achieve, and under which conditions.

Remove credentials, tokens and private application data from logs, screenshots and
Playwright traces before attaching them.

## Scope

Keywright runs Robot Framework tests and the project's Python code with the
permissions of the current user. Running tests executes the project's code, and
loading keyword documentation for the editor imports the project's Python
libraries, as the same commands would from the command line. Only open and run
projects you trust.

Opening a project is enough to run some of its code: to list keywords and check
files, Keywright starts the project's Python (`.venv`, or the interpreter in
`keywright.json`) and imports the project's libraries; Robocop reads the project's
configuration. An interpreter outside the project folder is used only after you
confirm it, once per project, or when you chose it in Project Settings. Git
commands in the Source Control panel use the repository's own configuration,
including hooks and filters, as Git does from the command line.

### AI clients (MCP server)

The MCP server is off until you turn it on. A client holding its token can do what
the tools offer: read and change project files, run tests and drive a browser.
Treat what the AI reads, such as web pages in its browser, as untrusted input that
can steer it. Keywright limits that browser to web pages (`http`, `https`) and
files inside the open project, refuses edits to files with unsaved changes, and
lists every file change with undo. It asks before an AI client first runs the tests of
a project; allowing lasts until you turn the server off or close Keywright. That
question does not isolate the project's code: a library the AI writes can be imported
when Keywright lists keywords, as described above, without a test run.
**Test connection** shows the command first when it comes from a configuration
file inside the project.

Robot reports and Playwright traces are served on `127.0.0.1` to Keywright's own
frames only: requests from other host names (DNS rebinding) or web pages are
refused. Those frames get no browser permissions and cannot navigate the window.

Problems in Robot Framework, Browser library, Playwright or Electron belong to
those projects. Report them upstream, and tell us if Keywright needs to change a
dependency version as a result.

Antivirus detections of Electron's executable are covered in
[Troubleshooting](docs/troubleshooting.md#antivirus-detects-electronexe).
