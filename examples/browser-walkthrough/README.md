# Keywright example project

A local access-request form and two Robot Framework tests for the
[Keywright walkthrough](../../docs/walkthrough.md). The page does not send email
or need an application server.

From this directory, prepare the test environment in PowerShell:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m Browser.entry init chromium
```

Open this directory in Keywright, select **Testing** and press **Run all**. Both
tests should pass. Follow the walkthrough to record another test and investigate
an intentional assertion failure.

To run the same tests from PowerShell:

```powershell
.\.venv\Scripts\python.exe -m robot --outputdir results tests
```

CI runs the supplied tests from the command line to check the example. Opening
the project, recording and inspecting results in Keywright are manual steps in
the walkthrough.
