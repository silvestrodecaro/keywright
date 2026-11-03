# Security policy

## Supported versions

Keywright runs from source and has no published releases. Security fixes are made
on the `main` branch. Update your checkout as described in
[updates and local settings](docs/user-guide.md#updates-and-local-settings) before
reporting a problem.

## Reporting a vulnerability

Report vulnerabilities privately through the repository's
[security advisories](https://github.com/silvestrodecaro/keywright/security/advisories/new)
page (**Security → Report a vulnerability**). Do not open a public issue for them.
If private reporting is unavailable, open an issue that asks for a private contact
and leave out the details.

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

Problems in Robot Framework, Browser library, Playwright or Electron belong to
those projects. Report them upstream, and tell us if Keywright needs to change a
dependency version as a result.

Antivirus detections of Electron's executable are covered in
[Troubleshooting](docs/troubleshooting.md#antivirus-detects-electronexe).
