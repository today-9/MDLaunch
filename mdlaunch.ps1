# MDLaunch 起動スクリプト(ターミナル用)
# 使い方: .\mdlaunch.ps1 [-Port 8321] [-Vault path\to\vault]
param(
    [int]$Port = 8321,
    [string]$Vault = ""
)

Set-Location $PSScriptRoot
$env:MDLAUNCH_PORT = "$Port"
if ($Vault) { $env:MDLAUNCH_VAULT = $Vault }

uv run python -m app.launch
