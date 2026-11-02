# Keywright example project

A local access-request form and two Robot Framework tests for the
[Keywright walkthrough](../../docs/walkthrough.md). The page does not send email
or need an application server.

Run [setup.bat](../../README.md#run-from-source) from the repository root.
It prepares this example's `.venv`, installs its dependencies and browser, and
checks both supplied tests. No separate environment setup is needed afterwards.

In Keywright, choose **Open folder…** and select this directory, then select
**Testing → Run all**. Both tests should pass. After installation, the local page
needs no server or network access. Follow the walkthrough to record another test
and investigate an intentional assertion failure.

To run the same tests from PowerShell:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$env:LOCALAPPDATA\ms-playwright"
.\.venv\Scripts\python.exe -m robot --outputdir results tests
```

Use your custom browser cache instead if `PLAYWRIGHT_BROWSERS_PATH` was explicitly
configured during setup. Set it in each new terminal session when running tests
outside Keywright.

CI checks the supplied tests directly and through Keywright's UI. The UI checks
also cover a failing assertion, its screenshot and navigation back to the source.
Recording a new test remains a manual step in the walkthrough.
