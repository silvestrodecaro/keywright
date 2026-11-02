# Keywright example project

A local access-request form and two Robot Framework tests for the
[Keywright walkthrough](../../docs/walkthrough.md). The page does not send email
or need an application server.

First [install and launch Keywright](../../README.md#run-from-source). Open a
second PowerShell window in this example directory
(`keywright/examples/browser-walkthrough`) and prepare its Python environment:

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m Browser.entry init chromium
```

These commands use Python 3.13 directly through the Windows launcher, then the
environment's own executable; activation is unnecessary.

In Keywright, choose **Open folder…** and select this directory, then select
**Testing → Run all**. Both tests should pass. After installation, the local page
needs no server or network access. Follow the walkthrough to record another test
and investigate an intentional assertion failure.

To run the same tests from PowerShell:

```powershell
.\.venv\Scripts\python.exe -m robot --outputdir results tests
```

CI checks the supplied tests directly and through Keywright's UI. The UI checks
also cover a failing assertion, its screenshot and navigation back to the source.
Recording a new test remains a manual step in the walkthrough.
