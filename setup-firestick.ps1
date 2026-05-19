# ============================================================
#  Fire Stick Kiosk-Setup – Löwen Dart Dashboard
#  Fire Stick IP: 192.178.8.177
# ============================================================

$FIRESTICK_IP = "192.168.8.177"
$ADB_PORT     = 5555
$APK_PATH     = "$PSScriptRoot\fully-kiosk-browser.apk"

# -- ADB prüfen --------------------------------------------------
if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    Write-Error "ADB nicht gefunden. Bitte Android Platform Tools installieren:"
    Write-Host  "  https://developer.android.com/tools/releases/platform-tools"
    exit 1
}

# -- Verbinden ---------------------------------------------------
Write-Host "`n[1/3] Verbinde mit Fire Stick ($FIRESTICK_IP)..." -ForegroundColor Cyan
adb connect "${FIRESTICK_IP}:${ADB_PORT}"
Start-Sleep -Seconds 2

$devices = (adb devices) -join "`n"
if ($devices -notmatch [regex]::Escape($FIRESTICK_IP)) {
    Write-Error "Verbindung fehlgeschlagen. Prüfe:"
    Write-Host  "  - ADB-Debugging unter Einstellungen → Mein Fire TV → Entwickleroptionen aktiviert?"
    Write-Host  "  - Fire Stick und PC im selben Netzwerk?"
    exit 1
}
Write-Host "Verbunden." -ForegroundColor Green

# -- APK installieren --------------------------------------------
Write-Host "`n[2/3] Installiere Fully Kiosk Browser..." -ForegroundColor Cyan

if (-not (Test-Path $APK_PATH)) {
    Write-Warning "APK nicht gefunden: $APK_PATH"
    Write-Host    "  Bitte Fully Kiosk Browser APK herunterladen:"
    Write-Host    "  https://www.fully-kiosk.com/en/#download"
    Write-Host    "  und als 'fully-kiosk-browser.apk' in diesen Ordner legen:`n  $PSScriptRoot"
    exit 1
}

adb -s "${FIRESTICK_IP}:${ADB_PORT}" install -r $APK_PATH
Write-Host "APK installiert." -ForegroundColor Green

# -- Autostart konfigurieren -------------------------------------
Write-Host "`n[3/3] Konfiguriere Autostart..." -ForegroundColor Cyan

# Fully Kiosk startet beim Boot (Intent-Broadcast aktivieren)
adb -s "${FIRESTICK_IP}:${ADB_PORT}" shell pm grant de.ozerov.fully android.permission.RECEIVE_BOOT_COMPLETED 2>$null

Write-Host @"

============================================================
 Setup abgeschlossen!
============================================================
 Naechste Schritte (direkt auf dem TV):
   1. Fully Kiosk Browser oeffnen
   2. Start URL eintragen: <deine Dashboard-URL>
   3. 'Autostart on Boot' aktivieren
   4. 'Keep Screen On' aktivieren (optional)
============================================================
"@ -ForegroundColor Green
