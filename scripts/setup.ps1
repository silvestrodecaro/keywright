param(
    [switch]$CheckOnly,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONUTF8 = '1'
$setupRoot = Split-Path -Parent $PSScriptRoot
$transcriptStarted = $false

function Write-SetupStatus([string]$Status, [string]$Message, [ConsoleColor]$Color = 'Green') {
    Write-Host ("  {0,-6} " -f $Status) -ForegroundColor $Color -NoNewline
    Write-Host $Message
}

function Find-Application([string]$Name) {
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

function Probe-Command([string]$Command, [string[]]$Arguments) {
    if (-not $Command) { return $null }
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Command @Arguments 2>$null
        if ($LASTEXITCODE -eq 0) { return ($output -join "`n").Trim() }
    } catch {}
    return $null
}

function Refresh-ProcessPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
        [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
}

function Install-Prerequisite([string]$Name, [string]$Package, [string]$DownloadUrl, [switch]$Node) {
    if ($CheckOnly -or $NonInteractive -or $env:CI) {
        throw "$Name is required. Run setup.bat interactively to offer installation, or install it from $DownloadUrl"
    }
    $winget = Find-Application 'winget'
    if (-not $winget) { throw "WinGet is unavailable. Install $Name from $DownloadUrl and run setup.bat again." }
    Write-Host ""
    Write-Host "$Name is required. WinGet will download its installer from the publisher."
    Write-Host 'Windows may ask for administrator approval.'
    $answer = Read-Host "Install $Name with WinGet? [y/n]"
    if ($answer -notmatch '^[yY]$') { throw "Installation declined. Install $Name before running setup again." }

    $installArguments = @('install', '--id', $Package, '--exact', '--source', 'winget',
        '--accept-source-agreements', '--accept-package-agreements')
    if ($Node) {
        # The LTS package also retains previous releases. Select a line verified in CI.
        $versions = Probe-Command $winget @('show', '--id', $Package, '--exact', '--source', 'winget',
            '--versions', '--accept-source-agreements', '--disable-interactivity')
        $supported = @($versions -split "`n" | Where-Object { $_.Trim() -match '^(24|26)\.\d+\.\d+$' } |
            ForEach-Object { [Version]$_.Trim() } | Sort-Object -Descending)
        if ($supported.Count -eq 0) { throw 'WinGet did not list a supported Node.js LTS release (24 or 26). Install it from nodejs.org and retry.' }
        $installArguments += @('--version', $supported[0].ToString())
    } else {
        $installArguments += @('--scope', 'user')
    }
    $ErrorActionPreference = 'Continue'
    & $winget @installArguments
    $installExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($installExit -ne 0) { throw "WinGet could not install $Name (exit $installExit). Review its message above and retry." }
    Refresh-ProcessPath
}

function Find-Node {
    $command = Find-Application 'node'
    $version = Probe-Command $command @('--version')
    if ($version -match '^v(24|26)\.\d+\.\d+$') {
        return [PSCustomObject]@{ Command = $command; Version = $version }
    }
    return $null
}

function Find-Python {
    foreach ($candidate in @(
        @{ Name = 'py'; Arguments = @('-3.13') },
        @{ Name = 'python'; Arguments = @() },
        @{ Name = 'python3'; Arguments = @() }
    )) {
        $command = Find-Application $candidate.Name
        $version = Probe-Command $command ($candidate.Arguments + @('--version'))
        if ($version -match '^Python 3\.13\.\d+$') {
            return [PSCustomObject]@{ Command = $command; Arguments = $candidate.Arguments; Version = $version }
        }
    }
    return $null
}

try {
    Set-Location -LiteralPath $setupRoot
    $logDirectory = Join-Path $setupRoot 'out\setup'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $bootstrapLog = Join-Path $logDirectory ("bootstrap-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + "-$PID.log")
    Start-Transcript -LiteralPath $bootstrapLog | Out-Null
    $transcriptStarted = $true
    $appVersion = (Get-Content -LiteralPath (Join-Path $setupRoot 'package.json') -Raw | ConvertFrom-Json).version
    Write-Host ''
    Write-Host '  | /   KEYWRIGHT' -ForegroundColor Cyan -NoNewline
    Write-Host "  $appVersion"
    Write-Host '  |<    Robot Framework + Browser'
    Write-Host '  | \   Setup for Windows' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host "Folder: $setupRoot"
    Write-Host "Prerequisite log: $bootstrapLog"
    Write-Host ''
    Write-Host '  Check prerequisites' -ForegroundColor White
    Write-Host ''
    $node = Find-Node
    if (-not $node) {
        $existingNode = Probe-Command (Find-Application 'node') @('--version')
        if ($existingNode) { Write-Host "Found Node.js $existingNode. Installing LTS may replace this Node.js version." }
        Install-Prerequisite 'Node.js LTS (24 or 26)' 'OpenJS.NodeJS.LTS' 'https://nodejs.org/en/download' -Node
        $node = Find-Node
        if (-not $node) { throw 'Node.js is still unavailable. Open a new terminal and run setup.bat again.' }
    }
    Write-SetupStatus 'OK' "Node.js $($node.Version)"
    $npm = Find-Application 'npm.cmd'
    $npmVersion = Probe-Command $npm @('--version')
    if (-not $npmVersion) { throw 'npm is missing. Repair the Node.js installation with npm enabled, then retry.' }
    Write-SetupStatus 'OK' "npm $npmVersion"
    $python = Find-Python
    if (-not $python) {
        Install-Prerequisite 'Python 3.13' 'Python.Python.3.13' 'https://www.python.org/downloads/windows/'
        $python = Find-Python
        if (-not $python) { throw 'Python 3.13 is still unavailable. Open a new terminal and run setup.bat again.' }
    }
    Write-SetupStatus 'OK' $python.Version
    $git = Probe-Command (Find-Application 'git') @('--version')
    if ($git) { Write-SetupStatus 'OK' $git }
    else { Write-SetupStatus 'INFO' 'Git is optional. Project Git initialization is unavailable until Git is installed.' 'Cyan' }
    if ($CheckOnly) {
        Write-Host 'Prerequisite checks passed. No dependencies were installed.'
        exit 0
    }

    $npmCli = Join-Path (Split-Path -Parent $npm) 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $npmCli)) { throw 'Cannot locate the npm CLI beside npm.cmd. Repair the Node.js/npm installation and retry.' }
    $pythonExe = Probe-Command $python.Command ($python.Arguments + @('-c', 'import sys; print(sys.executable)'))
    if (-not $pythonExe -or -not (Test-Path -LiteralPath $pythonExe)) { throw 'Cannot resolve the selected Python executable.' }
    & $node.Command (Join-Path $PSScriptRoot 'setup.js') --python $pythonExe --npm $npmCli
    $setupExit = $LASTEXITCODE
    if ($setupExit -ne 0) { exit $setupExit }
    if (-not $NonInteractive -and -not $env:CI) {
        $answer = Read-Host 'Open Keywright now? [y/n]'
        if ($answer -match '^[yY]$') {
            & $node.Command $npmCli start
            exit $LASTEXITCODE
        }
    }
    exit 0
} catch {
    Write-SetupStatus 'ERROR' $_.Exception.Message 'Red'
    exit 1
} finally {
    if ($transcriptStarted) { Stop-Transcript | Out-Null }
}
