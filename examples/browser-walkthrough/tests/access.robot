*** Settings ***
Resource         ../resources/access.resource
Test Setup       Open Demo Browser
Test Teardown    Close Browser    ALL


*** Test Cases ***
Access Form Is Ready
    [Tags]    smoke
    Get Text    role=heading[level=1]    ==    Request access

Member Can Request A Code
    [Tags]    smoke    access
    Request Access Code    ada@example.test
    Get Text    role=heading[level=1]    ==    Check your inbox
    Get Text    id=confirmation    ==    We prepared a demo code for ada@example.test.
