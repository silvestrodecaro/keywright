@echo off
setlocal
set "SETUP_ARGS="
set "NO_PAUSE="
if defined CI set "NO_PAUSE=1"

:options
if "%~1"=="" goto run
if /I "%~1"=="--check" (
  set "SETUP_ARGS=%SETUP_ARGS% -CheckOnly"
  goto next
)
if /I "%~1"=="--non-interactive" (
  set "SETUP_ARGS=%SETUP_ARGS% -NonInteractive"
  set "NO_PAUSE=1"
  goto next
)
if /I "%~1"=="--no-pause" (
  set "NO_PAUSE=1"
  goto next
)
if /I "%~1"=="--help" goto help
echo Unknown option: %~1
echo Usage: setup.bat [--check] [--non-interactive] [--no-pause]
exit /b 2

:next
shift
goto options

:run
pushd "%~dp0"
if errorlevel 1 exit /b 1
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %SETUP_ARGS%
set "SETUP_RESULT=%ERRORLEVEL%"
popd
if not defined NO_PAUSE pause
exit /b %SETUP_RESULT%

:help
echo Usage: setup.bat [--check] [--non-interactive] [--no-pause]
echo   --check              Check prerequisites without installing anything.
echo   --non-interactive    Never prompt or install missing system tools.
echo   --no-pause           Close without waiting for a key at the end.
exit /b 0
