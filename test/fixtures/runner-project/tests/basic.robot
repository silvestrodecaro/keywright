*** Test Cases ***
Passing Test
    [Tags]    smoke
    Log    hello from passing test
    Add Numbers    1    2

Failing Test
    Should Be Equal    1    2    values differ

Test With Control Structures
    FOR    ${i}    IN RANGE    2
        IF    ${i} == 1
            Log    second iteration
        END
    END

Name With [Brackets], Commas * And ? Wildcards
    No Operation


*** Keywords ***
Add Numbers
    [Arguments]    ${a}    ${b}
    ${sum}=    Evaluate    ${a} + ${b}
    Should Be Equal As Integers    ${sum}    3
