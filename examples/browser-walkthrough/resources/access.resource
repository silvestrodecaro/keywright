*** Settings ***
Library    Browser


*** Variables ***
${BROWSER}      chromium
${HEADLESS}     True
${DEMO_PAGE}    ${CURDIR}${/}..${/}site${/}index.html


*** Keywords ***
Open Demo Browser
    New Browser    ${BROWSER}    headless=${HEADLESS}
    New Context
    ${url}=    Evaluate    pathlib.Path($DEMO_PAGE).resolve().as_uri()    modules=pathlib
    New Page    ${url}

Request Access Code
    [Arguments]    ${email}
    Fill Text    id=email    ${email}
    Click    role=button[name="Request code"]
