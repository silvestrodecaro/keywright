# Record a test and investigate a failure

This walkthrough uses the [Keywright example project](../examples/browser-walkthrough/).
Its local access-request form works without a server, account or network connection.
Dependency and browser installation require downloads. The form does not send email.

You will run the supplied tests, record the same interaction, move repeated steps
into a resource, then inspect an intentional failure and its Playwright trace.

## Prepare the example

First [install and launch Keywright](../README.md#run-from-source). Then open a
second PowerShell window in the cloned `keywright` folder and run:

```powershell
cd examples/browser-walkthrough
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m Browser.entry init chromium
```

This prepares the example's own Python environment. It uses Python 3.13 and Node.js
24, as in the [tested environment](../CONTRIBUTING.md#verified-environment).
Activation is unnecessary: the commands use `.venv`'s Python directly.

In Keywright, choose **Open folder…** and select `examples/browser-walkthrough`
inside your clone. If another project is open, choose **Close project** first.
The project has this structure:

```text
browser-walkthrough/
  keywright.json
  requirements.txt
  resources/access.resource
  site/index.html
  tests/access.robot
```

In **Testing**, press **Run all**. Both supplied tests should pass. If they do not,
open **Console output** and follow [environment troubleshooting](troubleshooting.md).
The footer should name this example's `.venv\Scripts\python.exe`.

## Record the access request

Print the local page's URL from the example directory:

```powershell
.\.venv\Scripts\python.exe -c "from pathlib import Path; print(Path('site/index.html').resolve().as_uri())"
```

1. Open **Test Generator**, paste that URL and leave **Chromium** selected.
2. Press **Record**. If Keywright offers to install its recorder browser, complete
   that installation. It is separate from the project's Browser installation.
3. Enter `ada@example.test` in **Work email** and click **Request code**.
4. In the recording toolbar, choose a text assertion and select the heading
   **Check your inbox**.
5. Stop recording, name the test `Recorded Access Request`, and save it as
   `tests/recorded_access.robot` inside the example project.

Review the generated file. It should contain the navigation, field entry, button
click and heading assertion you recorded. Remove accidental actions. Keep selectors
specific: this page exposes `id=email` and a button named `Request code`.

Recording only the click would prove that the button can be clicked. The heading
assertion checks the response the test expects.

## Reuse the resource

Open `resources/access.resource`. `Open Demo Browser` creates a browser, an explicit
context and a page. It converts the local file path to a URL, so the suite works
when the example is moved to another directory. `Request Access Code` fills the
email field and clicks the button.

Replace the recorded file's contents with:

```robotframework
*** Settings ***
Resource         ../resources/access.resource
Test Setup       Open Demo Browser
Test Teardown    Close Browser    ALL


*** Test Cases ***
Recorded Access Request
    [Tags]    access
    Request Access Code    ada@example.test
    Get Text    role=heading[level=1]    ==    Check your inbox
```

The test now states the interaction and its expected result. Browser setup and
the repeated form steps live in the resource. Each test gets its own context;
teardown closes the browser and finishes its trace.

Press **Run all** in Testing. With an unsaved file, Keywright offers:

- **Save All and Run:** save all modified editor files, including resources and
  Python libraries, then discover and execute the saved tests.
- **Run Saved Files:** execute the files already on disk and keep editor changes
  unsaved. A notice in Testing identifies this choice.
- **Cancel:** return to editing.

Choose **Save All and Run**. The two supplied tests and your recorded test should
pass. The editor gutter and the result's **Run** button use the same preparation.
If a file changed externally, resolve the save conflict before retrying the run.

## Inspect an intentional failure

In `Recorded Access Request`, change only the expected heading:

```robotframework
    Get Text    role=heading[level=1]    ==    Welcome back
```

Keep **Record trace** enabled. Run that test from its editor gutter and choose
**Save All and Run** if prompted. The test should fail because the page displays
`Check your inbox`.

Select the failed test in **Testing**. In **Test Results**:

1. Read the assertion message: compare the actual and expected text.
2. Find the failing `Get Text` keyword in **Steps**. Expand it to inspect its logs.
3. Check the screenshot emitted by Browser. It shows the page at the failure.
4. Open **Trace** and select the `Get Text` action. Inspect the page snapshot and
   earlier actions to confirm whether the form interaction completed.
5. Choose **← Steps**, then **Go to source**, to return to the test.

Restore `Check your inbox` and rerun. A passing result confirms the assertion
matches this fixture. On a real application, decide whether the test expectation
or the application behavior is wrong before changing either.

Trace files become available when contexts close. This example creates an explicit
context in each test setup. Later runs can replace artifacts; copy evidence you
need to retain. [Results and traces](user-guide.md#results-and-traces) explains the
other context lifetimes and history limits.

## Run the same files outside Keywright

From the example directory:

```powershell
.\.venv\Scripts\python.exe -m robot --outputdir results tests
.\.venv\Scripts\python.exe -m robot --include smoke --outputdir results tests
```

The first command runs all saved tests, including your recorded file. The second
runs the two supplied tests tagged `smoke`. The files remain ordinary Robot
Framework source and use the same project Python as Keywright.
