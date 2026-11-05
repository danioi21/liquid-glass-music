# PowerShell script to create a shortcut with custom ICO icon
param(
    [string]$TargetPath = "$PSScriptRoot\start.bat",
    [string]$WorkingDirectory = $PSScriptRoot
)

$DesktopPath = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = "$DesktopPath\Liquid Glass Music.lnk"

# Сначала создадим ICO из PNG, если его нет
$icoPath = "$PSScriptRoot\assets\icon.ico"
if (-Not (Test-Path $icoPath)) {
    Add-Type -AssemblyName System.Drawing
    try {
        $img = [System.Drawing.Image]::FromFile("$PSScriptRoot\assets\icon.png")
        $bmp = New-Object System.Drawing.Bitmap($img, 256, 256)
        $bmp.Save($icoPath, [System.Drawing.Imaging.ImageFormat]::Icon)
        $bmp.Dispose()
        $img.Dispose()
        Write-Host "ICO создан: $icoPath"
    } catch {
        Write-Warning "Не удалось создать ICO, используем PNG"
        $icoPath = "$PSScriptRoot\assets\icon.png"
    }
}

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $TargetPath
$Shortcut.WorkingDirectory = $WorkingDirectory
$Shortcut.WindowStyle = 1  # Normal window
$Shortcut.Description = "Музыкальный виджет с интеграцией Яндекс Музыки"
$Shortcut.IconLocation = $icoPath

$Shortcut.Save()

Write-Host "Ярлык создан на рабочем столе: $ShortcutPath"
Write-Host "Иконка: $icoPath"