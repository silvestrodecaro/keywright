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

# banner.txt (UTF-8 pixel art) is shared with terminal.js; see the comment there.
# This script stays ASCII: Windows PowerShell 5.1 reads a .ps1 without a BOM in the
# ANSI code page, so block characters are built from code points.
function Read-Banner([string]$File = (Join-Path $PSScriptRoot 'banner.txt')) {
    if (-not (Test-Path -LiteralPath $File)) { return $null }
    $sections = @{}
    $current = $null
    foreach ($raw in Get-Content -LiteralPath $File -Encoding UTF8) {
        $line = $raw.TrimEnd()
        if (-not $line -or $line.StartsWith('#')) { continue }
        if ($line -match '^\[(\w+)\]$') {
            $current = $Matches[1]
            $sections[$current] = New-Object System.Collections.Generic.List[string]
        } elseif ($current) { $sections[$current].Add($line) }
    }
    foreach ($name in 'symbol', 'wordmark') {
        $rows = $sections[$name]
        if (-not $rows -or $rows.Count -eq 0) { return $null }
        foreach ($row in $rows) { if ($row.Length -ne $rows[0].Length -or $row -notmatch '^[.tdw]+$') { return $null } }
    }
    return $sections
}

# Two pixel rows become one line of half blocks, grouped into same-colour segments.
# Without colour the pixels in $Plain are left out (dark fill, wordmark shadow).
function Get-BannerLines($Rows, [string]$Plain, [bool]$Color) {
    $lines = @()
    for ($y = 0; $y -lt $Rows.Count; $y += 2) {
        $segments = New-Object System.Collections.Generic.List[object]
        for ($x = 0; $x -lt $Rows[$y].Length; $x++) {
            $top = [string]$Rows[$y][$x]
            $bottom = if ($y + 1 -lt $Rows.Count) { [string]$Rows[$y + 1][$x] } else { '.' }
            if ($top -eq '.' -or (-not $Color -and $Plain.Contains($top))) { $top = '' }
            if ($bottom -eq '.' -or (-not $Color -and $Plain.Contains($bottom))) { $bottom = '' }
            $glyph = ' '; $fg = $null; $bg = $null
            if ($top -and $top -eq $bottom) { $glyph = [char]0x2588; $fg = $top }
            elseif ($top -and $bottom) { $glyph = [char]0x2580; $fg = $top; $bg = $bottom }
            elseif ($top) { $glyph = [char]0x2580; $fg = $top }
            elseif ($bottom) { $glyph = [char]0x2584; $fg = $bottom }
            $fgName = if ($Color) { $fg } else { $null }
            $bgName = if ($Color) { $bg } else { $null }
            $last = if ($segments.Count) { $segments[$segments.Count - 1] } else { $null }
            if ($last -and $last.Fg -eq $fgName -and $last.Bg -eq $bgName) { $last.Text += $glyph }
            else { $segments.Add([PSCustomObject]@{ Text = [string]$glyph; Fg = $fgName; Bg = $bgName }) }
        }
        $lines += ,$segments
    }
    return ,$lines
}

# Segment colours are palette letters (t, d, w) or a console colour name for text.
$script:BannerPalette = @{
    t = @{ Rgb = '0;176;160'; Console = 'Cyan' }
    d = @{ Rgb = '36;44;52'; Console = 'Black' }
    w = @{ Rgb = '221;252;247'; Console = 'White' }
}

# Windows Terminal and the Windows 10+ console draw 24-bit colour once virtual terminal
# processing is on. Without it, Write-Host falls back to the 16 console colours.
function Enable-VirtualTerminal {
    try {
        if (-not ('KeywrightConsole' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KeywrightConsole {
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr handle, uint mode);
    public static bool EnableVirtualTerminal() {
        IntPtr output = GetStdHandle(-11);
        uint mode;
        if (!GetConsoleMode(output, out mode)) return false;
        return (mode & 4) != 0 || SetConsoleMode(output, mode | 4);
    }
}
'@
        }
        return [KeywrightConsole]::EnableVirtualTerminal()
    } catch { return $false }
}

function Write-BannerSegment($Segment, [bool]$VirtualTerminal) {
    if ($VirtualTerminal) {
        $codes = @()
        foreach ($layer in @(@($Segment.Fg, '38'), @($Segment.Bg, '48'))) {
            if ($layer[0] -and $script:BannerPalette.ContainsKey($layer[0])) { $codes += "$($layer[1]);2;$($script:BannerPalette[$layer[0]].Rgb)" }
            elseif ($layer[0] -eq 'DarkGray' -and $layer[1] -eq '38') { $codes += '90' }
        }
        $escape = [char]27
        if ($codes.Count) { [Console]::Write("$escape[$($codes -join ';')m$($Segment.Text)$escape[0m") }
        else { [Console]::Write($Segment.Text) }
        return
    }
    $options = @{ Object = $Segment.Text; NoNewline = $true }
    foreach ($layer in @(@($Segment.Fg, 'ForegroundColor'), @($Segment.Bg, 'BackgroundColor'))) {
        if (-not $layer[0]) { continue }
        $options[$layer[1]] = if ($script:BannerPalette.ContainsKey($layer[0])) { $script:BannerPalette[$layer[0]].Console } else { $layer[0] }
    }
    Write-Host @options
}

# The full banner needs a console wide enough for symbol and wordmark; redirected
# output, CI and narrow windows get the plain title.
function Write-Banner([string]$Version, [string]$Mode) {
    $art = Read-Banner
    $gap = 4
    $width = 0
    try { if (-not [Console]::IsOutputRedirected) { $width = [Console]::WindowWidth } } catch {}
    $dot = [char]0x00B7
    Write-Host ''
    if (-not $art -or $env:CI -or $width -lt (2 + $art.symbol[0].Length + $gap + $art.wordmark[0].Length)) {
        Write-Host '  KEYWRIGHT' -NoNewline
        Write-Host "  $Version" -ForegroundColor DarkGray
        Write-Host '  Record, edit and run Robot Framework web tests' -NoNewline
        Write-Host "  $dot  $Mode" -ForegroundColor DarkGray
        Write-Host ''
        return
    }
    $color = -not (Test-Path Env:NO_COLOR)
    $vt = $color -and (Enable-VirtualTerminal)
    $symbol = Get-BannerLines $art.symbol 'd' $color
    $wordmark = Get-BannerLines $art.wordmark 't' $color
    $text = @(
        [PSCustomObject]@{ Text = '  Record, edit and run Robot Framework web tests'; Fg = $null; Bg = $null },
        [PSCustomObject]@{ Text = "  $Version  $dot  $Mode"; Fg = $(if ($color) { 'DarkGray' }); Bg = $null }
    )
    $rightCount = $wordmark.Count + $text.Count
    $top = [Math]::Max(0, [Math]::Floor(($symbol.Count - $rightCount) / 2))
    for ($i = 0; $i -lt [Math]::Max($symbol.Count, $top + $rightCount); $i++) {
        Write-Host '  ' -NoNewline
        if ($i -lt $symbol.Count) { foreach ($segment in $symbol[$i]) { Write-BannerSegment $segment $vt } }
        else { Write-Host (' ' * $art.symbol[0].Length) -NoNewline }
        $right = $i - $top
        if ($right -ge 0 -and $right -lt $rightCount) {
            Write-Host (' ' * $gap) -NoNewline
            if ($right -lt $wordmark.Count) { foreach ($segment in $wordmark[$right]) { Write-BannerSegment $segment $vt } }
            else { Write-BannerSegment $text[$right - $wordmark.Count] $vt }
        }
        Write-Host ''
    }
    Write-Host ''
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
    $appVersion = ''
    try { $appVersion = (Get-Content -LiteralPath (Join-Path $setupRoot 'package.json') -Raw | ConvertFrom-Json).version } catch {}
    # Before the transcript: it records each coloured segment on a separate line.
    Write-Banner $appVersion 'Setup for Windows'
    $logDirectory = Join-Path $setupRoot 'out\setup'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $bootstrapLog = Join-Path $logDirectory ("bootstrap-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + "-$PID.log")
    Start-Transcript -LiteralPath $bootstrapLog | Out-Null
    $transcriptStarted = $true
    Write-Host "Keywright $appVersion setup"
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
