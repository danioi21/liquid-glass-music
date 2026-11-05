# ============================================================
#  Liquid Glass Music — one-click launcher
#  Double-click start.bat. On first run it downloads a portable
#  Node.js into .runtime\ and installs Electron.
# ============================================================

$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

$root = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $root '.runtime'
$portableNodeDir = Join-Path $runtimeDir 'node'
$portableNodeExe = Join-Path $portableNodeDir 'node.exe'
$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$bridgeExe = Join-Path $root 'smtc\bridge\SmtcBridge.exe'
$logDir = Join-Path $env:TEMP 'liquid-glass-music'

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "  $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
    Write-Host "  $Text" -ForegroundColor Green
}

function Fail([string]$Text) {
    Write-Host ''
    Write-Host "  ОШИБКА: $Text" -ForegroundColor Red
    Write-Host ''
    exit 1
}

Write-Host ''
Write-Host '  ╭──────────────────────────────────────────╮' -ForegroundColor Magenta
Write-Host '  │   Liquid Glass Music · Яндекс Музыка     │' -ForegroundColor Magenta
Write-Host '  ╰──────────────────────────────────────────╯' -ForegroundColor Magenta

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# --- 1. Node.js -------------------------------------------------
$nodeExe = $null
$npmCmd = $null

$systemNode = Get-Command node -ErrorAction SilentlyContinue
$systemNpm = Get-Command npm -ErrorAction SilentlyContinue

if ($systemNode -and $systemNpm) {
    $nodeExe = $systemNode.Source
    $npmCmd = Join-Path (Split-Path $nodeExe) 'npm.cmd'
    if (-not (Test-Path $npmCmd)) { $npmCmd = $systemNpm.Source }
    Write-Ok "Node.js найден в системе: $nodeExe"
} elseif (Test-Path $portableNodeExe) {
    $nodeExe = $portableNodeExe
    $npmCmd = Join-Path $portableNodeDir 'npm.cmd'
    Write-Ok 'Использую portable Node.js из .runtime'
} else {
    Write-Step 'Первый запуск: скачиваю portable Node.js (около 35 МБ)…'

    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

    $version = $null
    try {
        $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
        $version = ($index | Where-Object { $_.version -like 'v22.*' } | Select-Object -First 1).version
    } catch { }

    if (-not $version) { $version = 'v22.23.4' }

    $zipName = "node-$version-win-x64.zip"
    $zipPath = Join-Path $runtimeDir 'node.zip'
    $url = "https://nodejs.org/dist/$version/$zipName"

    try {
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 600
        Expand-Archive -Path $zipPath -DestinationPath $runtimeDir -Force
        Move-Item -Force (Join-Path $runtimeDir "node-$version-win-x64") $portableNodeDir
        Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
    } catch {
        Fail "не удалось скачать Node.js. Проверьте интернет и повторите. $($_.Exception.Message)"
    }

    if (-not (Test-Path $portableNodeExe)) {
        Fail 'Node.js скачался, но не распаковался. Удалите папку .runtime и попробуйте снова.'
    }

    $nodeExe = $portableNodeExe
    $npmCmd = Join-Path $portableNodeDir 'npm.cmd'
    Write-Ok 'Node.js установлен в .runtime\node'
}

# --- 2. Electron -------------------------------------------------
if (-not (Test-Path $electronExe)) {
    Write-Step 'Устанавливаю Electron (первый запуск, 2–5 минут)…'
    Write-Host '  Скачивается около 120 МБ. Это нормально.' -ForegroundColor DarkGray

    Push-Location $root
    try {
        & $npmCmd install --no-audit --no-fund
    } catch {
        Write-Host "  Предупреждение: $($_.Exception.Message)" -ForegroundColor Yellow
    } finally {
        Pop-Location
    }

    if (-not (Test-Path $electronExe)) {
        $installJs = Join-Path $root 'node_modules\electron\install.js'
        if (Test-Path $installJs) {
            Write-Step 'Пробую скачать Electron с зеркала…'
            $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
            Push-Location (Join-Path $root 'node_modules\electron')
            try {
                & $nodeExe install.js
            } catch {
                Write-Host "  Предупреждение: $($_.Exception.Message)" -ForegroundColor Yellow
            } finally {
                Pop-Location
            }
        }
    }

    if (-not (Test-Path $electronExe)) {
        Write-Step 'Пробую установить Electron через npm…'
        $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
        Push-Location $root
        try {
            & $npmCmd install --no-audit --no-fund
        } catch {
            Write-Host "  Предупреждение: $($_.Exception.Message)" -ForegroundColor Yellow
        } finally {
            Pop-Location
        }
    }

    if (-not (Test-Path $electronExe)) {
        Fail 'Electron не установился. Проверьте интернет (GitHub/npm) и запустите start.bat ещё раз.'
    }

    Write-Ok 'Electron установлен.'
} else {
    Write-Ok 'Electron уже установлен.'
}

# --- 3. Media bridge --------------------------------------------
if (-not (Test-Path $bridgeExe)) {
    Fail 'Не найден smtc\bridge\SmtcBridge.exe. Папка проекта повреждена — распакуйте архив заново.'
}
Write-Ok 'Мост к медиасессии Windows на месте.'

# --- 4. Launch ---------------------------------------------------
$existing = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -like '*Liquid Glass Music*' } |
    Select-Object -First 1

if ($existing) {
    Write-Ok 'Виджет уже запущен — окно на панели задач.'
    exit 0
}

Write-Step 'Запускаю виджет…'

# No stdout/stderr redirection here: Start-Process then uses ShellExecute,
# so Electron is fully detached and the console window closes immediately.
try {
    $process = Start-Process -FilePath $electronExe `
        -ArgumentList '.' `
        -WorkingDirectory $root `
        -PassThru
} catch {
    Fail "Electron не запустился: $($_.Exception.Message)"
}

Start-Sleep -Seconds 2

if ($process.HasExited) {
    if ($process.ExitCode -eq 0) {
        Write-Ok 'Виджет уже запущен.'
        exit 0
    }

    Write-Host ''
    Write-Host "  Electron завершился с кодом $($process.ExitCode)." -ForegroundColor Red
    $appLog = Join-Path $logDir 'app.log'
    if (Test-Path $appLog) {
        Write-Host '  Последние строки лога:' -ForegroundColor DarkGray
        Get-Content $appLog -Tail 12 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    }
    Write-Host ''
    Write-Host '  Подробный запуск: npm start' -ForegroundColor DarkGray
    exit 1
}

Write-Ok 'Готово! Виджет запущен.'
Write-Host ''
Write-Host '  Если окно не видно — проверьте панель задач.' -ForegroundColor DarkGray
Write-Host "  Лог: $logDir\app.log" -ForegroundColor DarkGray
Write-Host '  Трек берётся из Яндекс Музыки автоматически.' -ForegroundColor DarkGray
Write-Host ''
Start-Sleep -Milliseconds 500
