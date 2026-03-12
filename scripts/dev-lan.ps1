param(
  [string]$LanIp = "",
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

function Get-DetectedLanIp {
  try {
    $candidates = Get-NetIPAddress -AddressFamily IPv4 |
      Where-Object {
        $_.IPAddress -notlike "127.*" -and
        $_.IPAddress -notlike "169.254.*" -and
        (
          $_.IPAddress -like "192.168.*" -or
          $_.IPAddress -like "10.*" -or
          $_.IPAddress -like "172.16.*" -or
          $_.IPAddress -like "172.17.*" -or
          $_.IPAddress -like "172.18.*" -or
          $_.IPAddress -like "172.19.*" -or
          $_.IPAddress -like "172.2*.*" -or
          $_.IPAddress -like "172.30.*" -or
          $_.IPAddress -like "172.31.*"
        )
      }
    if ($candidates) {
      return ($candidates | Select-Object -First 1).IPAddress
    }
  } catch {
    # Fallback for restricted shells.
  }

  $dnsCandidates = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
    Where-Object {
      $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
      $_.IPAddressToString -notlike "127.*" -and
      $_.IPAddressToString -notlike "169.254.*"
    } |
    ForEach-Object { $_.IPAddressToString }

  if ($dnsCandidates) {
    return ($dnsCandidates | Select-Object -First 1)
  }

  return $null
}

function Set-ClientServerUrl {
  param([string]$IpAddress)

  $envPath = Join-Path $PSScriptRoot "..\client\.env.local"
  $envPath = [System.IO.Path]::GetFullPath($envPath)
  $targetLine = "VITE_SERVER_URL=http://$IpAddress`:3001"

  if (-not (Test-Path $envPath)) {
    Set-Content -Path $envPath -Value $targetLine
    Write-Host "[LAN] Created client/.env.local with VITE_SERVER_URL"
    return
  }

  $lines = Get-Content $envPath
  $hasKey = $false
  $newLines = foreach ($line in $lines) {
    if ($line -match "^VITE_SERVER_URL=") {
      $hasKey = $true
      $targetLine
    } else {
      $line
    }
  }

  if (-not $hasKey) {
    $newLines += $targetLine
  }

  Set-Content -Path $envPath -Value $newLines
  Write-Host "[LAN] Updated VITE_SERVER_URL -> http://$IpAddress`:3001"
}

if ([string]::IsNullOrWhiteSpace($LanIp)) {
  $LanIp = Get-DetectedLanIp
}

if ([string]::IsNullOrWhiteSpace($LanIp)) {
  throw "No pude detectar IP LAN. Ejecuta: npm run dev:lan -- -LanIp 192.168.x.x"
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$serverDir = Join-Path $repoRoot "server"
$clientDir = Join-Path $repoRoot "client"

Set-ClientServerUrl -IpAddress $LanIp

Write-Host ""
Write-Host "LAN config"
Write-Host "Frontend : http://$LanIp`:5173"
Write-Host "Backend  : http://$LanIp`:3001"
Write-Host ""

if ($NoStart) {
  Write-Host "[LAN] NoStart enabled. Saliendo despues de configurar."
  exit 0
}

Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  "cd '$serverDir'; npm run dev"
) | Out-Null

Start-Sleep -Milliseconds 400

Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  "cd '$clientDir'; npm run dev"
) | Out-Null

Write-Host "[LAN] Backend y frontend iniciados en ventanas separadas."
Write-Host "[LAN] Prueba en movil:"
Write-Host "  1) http://$LanIp`:5173"
Write-Host "  2) http://$LanIp`:3001/socket.io/?EIO=4&transport=polling"
