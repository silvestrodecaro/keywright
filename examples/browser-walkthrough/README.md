# Browser walkthrough project

A local access-request form and two Robot Framework tests for the
[Keywright walkthrough](../../docs/walkthrough.md). The page does not send email
or need an application server.

From this directory, prepare the test environment in PowerShell:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m Browser.entry init chromium
.\.venv\Scripts\python.exe -m robot --outputdir results tests
```

The expected result is two passing tests. Open this directory in Keywright to run
them, record another test and investigate an intentional assertion failure.
