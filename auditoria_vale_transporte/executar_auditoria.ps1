param(
    [string]$Competencia = "",
    [string]$Entradas = "",
    [string]$Saida = ""
)

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$Packages = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules"
$LocalModules = Join-Path $ProjectRoot "node_modules"

if (-not (Test-Path -LiteralPath $Node)) {
    throw "Runtime Node do Codex nao encontrado em: $Node"
}

if (-not (Test-Path -LiteralPath $LocalModules)) {
    New-Item -ItemType Junction -Path $LocalModules -Target $Packages | Out-Null
}

$argsList = @((Join-Path $ProjectRoot "auditar_vt.mjs"))
if ($Competencia) { $argsList += @("--competencia", $Competencia) }
if ($Entradas) { $argsList += @("--input", $Entradas) }
if ($Saida) { $argsList += @("--output", $Saida) }

$startedAt = Get-Date
& $Node @argsList
$recentReport = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "outputs") -Recurse -Filter "*.xlsx" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $startedAt.AddSeconds(-2) } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if ($LASTEXITCODE -ne 0 -and -not $recentReport) {
    throw "A auditoria terminou com erro."
}

if ($recentReport) {
    Write-Output "Relatorio criado: $($recentReport.FullName)"
}
