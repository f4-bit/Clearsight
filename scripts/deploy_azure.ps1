#Requires -Version 5.1
<#
.SYNOPSIS
    Plan-first, run-scoped Azure provisioning for the Clearsight stack.

.DESCRIPTION
    Creates an isolated Azure run identified by `clearsight-<runId>`:

      1. Resource group (tags on every resource)
      2. Blob Storage account + containers (raw, gradcam, mask, overlay, pdf, models)
      3. Azure Container Registry (Basic) and five SHA-tagged images
      4. PostgreSQL Flexible Server + database + firewall
      5. Azure Cache for Redis (Basic C0)
      6. Container Apps environment
      7. Manual Container Apps jobs: prisma:deploy (migrate) and admin:bootstrap
      8. Container Apps: ml-service, backend, worker, frontend

    Without `-Apply` the script only computes and writes a plan manifest; it
    never calls a mutating `az` verb. With `-Apply` it re-validates the
    subscription, scope, budget, duration and provider/permission context just
    before the first create, then runs. A manifest without secrets is written to
    `artifacts/azure-runs/<runId>/manifest.json`.

    Secrets are accepted only through `SecureString` parameters or generated in
    memory and passed to Container Apps as `--secrets`/`secretref`. The script
    never reads a local env file, never prints secret values and never places
    them in the manifest.

.PARAMETER SubscriptionId
    Subscription the run must use. The active CLI context MUST match it.

.PARAMETER ResourceGroup
    Run-scoped resource group name. It must include the run id.

.PARAMETER Location
    Azure region for the run.

.PARAMETER Scope
    Confirmed resource scope for the run (for example `rg:<name>`).

.PARAMETER BudgetUsd
    Confirmed numeric budget (> 0) for the run.

.PARAMETER DurationHours
    Confirmed maximum duration (> 0) used for the `expiresAt` tag and TTL.

.PARAMETER RunId
    Unique run identifier. It is sanitized to `[a-z0-9-]` and used for the
    `clearsight-<runId>` prefix and the `runId` tag.

.PARAMETER Owner
    Owner recorded in every tag.

.PARAMETER Apply
    Apply the plan. Without it the script is plan-only.

.PARAMETER KeepForDebug
    Skip the automatic `finally` teardown. Explicit opt-in; resources remain
    until `scripts/teardown_azure.ps1 -ManifestPath ...` is run.

.PARAMETER ImageSha
    Image tag SHA. Defaults to `git rev-parse --short=12 HEAD`.

.EXAMPLE
    pwsh ./scripts/deploy_azure.ps1 -SubscriptionId <guid> -ResourceGroup clearsight-run123 `
        -Location eastus2 -Scope rg:clearsight-run123 -BudgetUsd 20 -DurationHours 4 `
        -RunId run123 -Owner dev

.EXAMPLE
    pwsh ./scripts/deploy_azure.ps1 ... -Apply
#>
[CmdletBinding()]
param(
    [string]$SubscriptionId = "",
    [string]$ResourceGroup = "",
    [string]$Location = "",
    [string]$Scope = "",
    [string]$BudgetUsd = "",
    [string]$DurationHours = "",
    [string]$RunId = "",
    [string]$Owner = "",
    [switch]$Apply,
    [switch]$KeepForDebug,
    [string]$ImageSha = "",
    [string]$PostgresAdmin = "clearsightadmin",
    [string]$PostgresDatabase = "clearsight",
    [securestring]$PostgresPassword,
    [string]$BootstrapAdminEmail = "",
    [securestring]$BootstrapAdminPassword,
    [string]$ModelsDir = "",
    [switch]$SkipModelUpload,
    [string]$ManifestRoot = "",
    [int]$CleanupTimeoutSeconds = 300,
    [int]$CleanupPollSeconds = 10
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$script:SecretValues = New-Object System.Collections.Generic.List[string]
$script:CreatedAny = $false
$script:Manifest = $null
$script:ManifestPath = ""
$script:AzExe = "az"

function Write-Info([string]$Message) {
    Write-Host "[clearsight] $Message" -ForegroundColor Cyan
}

function Write-Warn([string]$Message) {
    Write-Host "[clearsight] $Message" -ForegroundColor Yellow
}

function Fail-Blocked([string]$Message) {
    Write-Host "[clearsight] BLOQUEO: $Message" -ForegroundColor Red
    exit 1
}

function Protect-Message([string]$Message) {
    $result = $Message
    foreach ($secret in $script:SecretValues) {
        if ($secret -and $secret.Length -ge 4) {
            $result = $result.Replace($secret, "***")
        }
    }
    return $result
}

function Register-Secret([string]$Value) {
    if ($Value) { $script:SecretValues.Add($Value) }
    return $Value
}

function ConvertTo-PlainText([securestring]$Secure) {
    if ($null -eq $Secure) { return $null }
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function New-StrongPassword {
    $raw = ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N"))
    return "Aa1!" + $raw.Substring(0, 20)
}

function New-StrongToken([int]$Length = 40) {
    $bytes = New-Object byte[] ($Length * 2)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $raw = [Convert]::ToBase64String($bytes)
    $clean = ($raw -replace '[^A-Za-z0-9]', '')
    if ($clean.Length -lt $Length) {
        return ($clean + ("Aa1" * 16)).Substring(0, $Length)
    }
    return $clean.Substring(0, $Length)
}

# ---------------------------------------------------------------------------
# Mandatory decisions: validated BEFORE any `az` invocation.
# ---------------------------------------------------------------------------
$missing = New-Object System.Collections.Generic.List[string]
if ([string]::IsNullOrWhiteSpace($SubscriptionId)) { $missing.Add("SubscriptionId") }
if ([string]::IsNullOrWhiteSpace($ResourceGroup)) { $missing.Add("ResourceGroup") }
if ([string]::IsNullOrWhiteSpace($Location)) { $missing.Add("Location") }
if ([string]::IsNullOrWhiteSpace($Scope)) { $missing.Add("Scope") }
if ([string]::IsNullOrWhiteSpace($BudgetUsd)) { $missing.Add("BudgetUsd") }
if ([string]::IsNullOrWhiteSpace($DurationHours)) { $missing.Add("DurationHours") }
if ([string]::IsNullOrWhiteSpace($RunId)) { $missing.Add("RunId") }
if ([string]::IsNullOrWhiteSpace($Owner)) { $missing.Add("Owner") }
if ($missing.Count -gt 0) {
    Fail-Blocked ("faltan decisiones obligatorias: {0}" -f ($missing -join ", "))
}

$invariant = [System.Globalization.CultureInfo]::InvariantCulture

function Get-FinitePositiveDouble {
    param([string]$Raw, [string]$Name)
    $parsed = 0.0
    $ok = [double]::TryParse($Raw, [System.Globalization.NumberStyles]::Float, $invariant, [ref]$parsed)
    if (-not $ok -or [double]::IsNaN($parsed) -or [double]::IsInfinity($parsed) -or $parsed -le 0) {
        $label = "presupuesto (BudgetUsd)"
        if ($Name -ne "BudgetUsd") { $label = "duración (DurationHours)" }
        Fail-Blocked ("{0} debe ser un número finito y positivo (recibido: '{1}')." -f $label, $Raw)
    }
    return $parsed
}

$budgetValue = Get-FinitePositiveDouble -Raw $BudgetUsd -Name "BudgetUsd"
$durationValue = Get-FinitePositiveDouble -Raw $DurationHours -Name "DurationHours"
if ($durationValue -gt 72) {
    Write-Warn "Duración superior a 72 h; el TTL del run será largo."
}

$runIdSafe = ($RunId.ToLowerInvariant() -replace '[^a-z0-9-]', '-')
$runIdSafe = ($runIdSafe -replace '-{2,}', '-').Trim('-')
if (-not $runIdSafe) {
    Fail-Blocked "RunId no contiene caracteres utilizables ([a-z0-9-])."
}
if ($runIdSafe.Length -gt 64) {
    $runIdSafe = $runIdSafe.Substring(0, 64).Trim('-')
}

# Container App names are limited to 32 characters. Keep a deterministic short
# token for resource names while the tag/manifest keep the full run id.
$resourceToken = $runIdSafe
if ($resourceToken.Length -gt 12) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($runIdSafe))
    }
    finally {
        $sha.Dispose()
    }
    $hex = ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLowerInvariant()
    $resourceToken = $runIdSafe.Substring(0, 8) + $hex.Substring(0, 4)
}

$rgName = $ResourceGroup.Trim()
$rgLower = $rgName.ToLowerInvariant()
if ($rgLower.IndexOf($runIdSafe) -lt 0 -and $rgLower.IndexOf($resourceToken) -lt 0) {
    Fail-Blocked "ResourceGroup debe incluir el RunId '$runIdSafe' para mantener el aislamiento."
}

$RunPrefix = "clearsight-$resourceToken"
$compact = "clearsight" + ($resourceToken -replace '-', '')
if ($compact.Length -gt 24) { $compact = $compact.Substring(0, 24) }
$StorageName = $compact
$acrName = $compact
if ($acrName.Length -gt 50) { $acrName = $acrName.Substring(0, 50) }
$PostgresName = "$RunPrefix-pg"
$RedisName = "$RunPrefix-redis"
$EnvName = "$RunPrefix-env"
$MlApp = "$RunPrefix-ml"
$BackendApp = "$RunPrefix-backend"
$WorkerApp = "$RunPrefix-worker"
$FrontendApp = "$RunPrefix-frontend"
$MigrateJob = "$RunPrefix-migrate"
$BootstrapJob = "$RunPrefix-bootstrap"

$now = (Get-Date).ToUniversalTime()
$createdAt = $now.ToString("o")
try {
    $expiresAt = $now.AddHours($durationValue).ToString("o")
}
catch {
    Fail-Blocked ("duración (DurationHours) fuera de rango para el TTL (recibido: '{0}')." -f $DurationHours)
}

$tags = [ordered]@{
    project   = "clearsight"
    runId     = $runIdSafe
    owner     = $Owner
    expiresAt = $expiresAt
    managedBy = "scripts/deploy_azure.ps1"
}
$tagArgs = New-Object System.Collections.Generic.List[string]
foreach ($key in $tags.Keys) { $tagArgs.Add("$key=$($tags[$key])") }

$ProviderNamespaces = @(
    "Microsoft.Resources",
    "Microsoft.Storage",
    "Microsoft.ContainerRegistry",
    "Microsoft.DBforPostgreSQL",
    "Microsoft.Cache",
    "Microsoft.App",
    "Microsoft.Network"
)

$Containers = @(
    "raw-retinas",
    "gradcam-overlays",
    "segmentation-masks",
    "segmentation-overlays",
    "clinical-reports",
    "models"
)

if (-not $ModelsDir) { $ModelsDir = Join-Path $RepoRoot "models_cache" }
if (-not $ManifestRoot) { $ManifestRoot = Join-Path $RepoRoot "artifacts/azure-runs" }
$script:ManifestPath = [System.IO.Path]::Combine($ManifestRoot, $runIdSafe, "manifest.json")

# ---------------------------------------------------------------------------
# Azure CLI resolution (test seam: CLEARSIGHT_AZ_EXE).
# ---------------------------------------------------------------------------
$azOverride = [System.Environment]::GetEnvironmentVariable("CLEARSIGHT_AZ_EXE")
if ($azOverride) {
    if (-not (Test-Path -LiteralPath $azOverride)) {
        Fail-Blocked "CLEARSIGHT_AZ_EXE apunta a una ruta inexistente."
    }
    $script:AzExe = $azOverride
}
else {
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        $azFallbackPath = "C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin"
        if (Test-Path -LiteralPath (Join-Path $azFallbackPath "az.cmd")) {
            $env:PATH = "$env:PATH;$azFallbackPath"
            Write-Warn "Azure CLI (az) was not on PATH; added '$azFallbackPath' for this process."
        }
    }
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw "Azure CLI (az) was not found on PATH. Install it from https://aka.ms/azure-cli."
    }
}

function Invoke-AzCli {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$Operation = "az"
    )
    & $script:AzExe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI command failed (exit $LASTEXITCODE): $Operation"
    }
}

function Test-AzExists {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        & $script:AzExe @Arguments 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    }
    catch {
        return $false
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

function Get-AzValue {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$Operation = "az query"
    )
    $value = & $script:AzExe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI query failed (exit $LASTEXITCODE): $Operation"
    }
    return ("$value").Trim()
}

function Get-TagsForId {
    param([string]$Id)
    if (-not $Id) { return $null }
    $json = Get-AzValue @("resource", "show", "--ids", $Id, "--query", "tags", "-o", "json") -Operation "resource tags"
    if (-not $json -or $json -eq "null") { return $null }
    return ($json | ConvertFrom-Json)
}

function Get-TagValue {
    param($Tags, [string]$Name)
    if ($null -eq $Tags) { return $null }
    if ($Tags -is [System.Collections.IDictionary]) {
        if ($Tags.Contains($Name)) { return $Tags[$Name] }
        return $null
    }
    $property = $Tags.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}

function Assert-RunOwnership {
    param([string]$Type, [string]$Name, [string]$Id)
    $live = Get-TagsForId $Id
    $liveRunId = Get-TagValue $live "runId"
    if (-not $liveRunId -or $liveRunId -ne $runIdSafe) {
        throw "$Type '$Name' ya existe sin la tag runId del run; no se reutiliza ni se borra."
    }
}

function Add-ManifestResource {
    param(
        [string]$Type,
        [string]$Name,
        [string]$Id,
        [System.Collections.IDictionary]$ResourceTags,
        [System.Collections.IDictionary]$Extra
    )
    $existing = @($script:Manifest["resources"] | Where-Object { $_.type -eq $Type -and $_.name -eq $Name })
    if ($existing.Count -gt 0) { return }
    $entry = [ordered]@{ type = $Type; name = $Name; id = $Id; tags = $ResourceTags }
    if ($null -ne $Extra) {
        foreach ($key in $Extra.Keys) { $entry[$key] = $Extra[$key] }
    }
    $script:Manifest["resources"] = @($script:Manifest["resources"]) + $entry
}

function Save-Manifest {
    $directory = Split-Path -Parent $script:ManifestPath
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $json = $script:Manifest | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($script:ManifestPath, $json, [System.Text.UTF8Encoding]::new($false))
}

$script:Manifest = [ordered]@{
    schemaVersion   = 1
    mode            = $(if ($Apply) { "apply" } else { "plan" })
    runId           = $runIdSafe
    runIdRequested  = $RunId
    owner           = $Owner
    prefix          = $RunPrefix
    location        = $Location
    scope           = $Scope
    budgetUsd       = $budgetValue
    durationHours   = $durationValue
    createdAt       = $createdAt
    expiresAt       = $expiresAt
    tags            = $tags
    resourceGroup   = [ordered]@{ name = $rgName; id = $null; createdByRun = $false; tags = $tags }
    resources       = @()
    images          = [ordered]@{}
    endpoints       = [ordered]@{}
    jobs            = [ordered]@{ migrate = "not-created"; bootstrap = "not-created" }
    cleanup         = [ordered]@{ status = "not-started"; checkedAt = $null; residuals = @(); message = "" }
}

# ---------------------------------------------------------------------------
# Image plan (SHA-tagged) is always computed.
# ---------------------------------------------------------------------------
if (-not $ImageSha) {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
        $resolved = (& git -C $RepoRoot rev-parse --short=12 HEAD) 2>$null
        if ($LASTEXITCODE -eq 0) { $ImageSha = "$resolved".Trim() }
    }
    if (-not $ImageSha) {
        Fail-Blocked "no se pudo resolver el SHA de las imágenes; pase -ImageSha."
    }
}
$ImageSha = $ImageSha.ToLowerInvariant()

$imageRefs = [ordered]@{
    "backend"    = "clearsight-backend:$ImageSha"
    "migrate"    = "clearsight-migrate:$ImageSha"
    "worker"     = "clearsight-worker:$ImageSha"
    "frontend"   = "clearsight-frontend:$ImageSha"
    "ml-service" = "clearsight-ml-service:$ImageSha"
}
$dockerfiles = @{
    "backend"    = "docker/backend.Dockerfile"
    "migrate"    = "docker/migrate.Dockerfile"
    "worker"     = "docker/worker.Dockerfile"
    "frontend"   = "docker/frontend.Dockerfile"
    "ml-service" = "docker/ml-service.Dockerfile"
}
foreach ($key in $imageRefs.Keys) {
    $script:Manifest["images"][$key] = [ordered]@{ tag = $imageRefs[$key]; digest = $null }
}

function Write-Plan {
    Write-Info "Plan del run (modo: $(if ($Apply) { 'apply' } else { 'plan' }))."
    Write-Host "  Run            : $runIdSafe"
    Write-Host "  Prefix         : $RunPrefix"
    Write-Host "  Resource group : $rgName ($Location)"
    Write-Host "  Scope          : $Scope"
    Write-Host "  Budget / TTL   : USD $budgetValue / $durationValue h (expira $expiresAt)"
    Write-Host "  Storage        : $StorageName"
    Write-Host "  Registry       : $acrName"
    Write-Host "  PostgreSQL     : $PostgresName/$PostgresDatabase"
    Write-Host "  Redis          : $RedisName"
    Write-Host "  Container apps : $MlApp, $BackendApp, $WorkerApp, $FrontendApp"
    Write-Host "  Jobs           : $MigrateJob (prisma:deploy), $BootstrapJob (admin:bootstrap)"
    Write-Host "  Images         : $($imageRefs.Values -join ', ')"
    Write-Host "  Manifest       : $script:ManifestPath"
    Write-Host "  Tags           : $($tagArgs -join ', ')"
}

# Plan mode: write the manifest and stop before any mutating command.
if (-not $Apply) {
    $script:Manifest["cleanup"]["status"] = "plan-only"
    Write-Plan
    Save-Manifest
    Write-Info "Manifest de plan escrito sin secretos."
    exit 0
}

function Assert-DeployGate {
    Write-Info "Gate: revalidando contexto, permisos y decisiones antes de crear."
    if ($budgetValue -le 0) { throw "GATE: presupuesto no confirmado." }
    if ($durationValue -le 0) { throw "GATE: duración no confirmada." }
    if ([string]::IsNullOrWhiteSpace($Scope)) { throw "GATE: scope no confirmado." }

    $activeId = Get-AzValue @("account", "show", "--query", "id", "-o", "tsv") -Operation "account context"
    if ($activeId -ne $SubscriptionId) {
        throw "GATE: la suscripción activa no coincide con -SubscriptionId (contexto no confirmado)."
    }
    $state = Get-AzValue @("account", "show", "--query", "state", "-o", "tsv") -Operation "account state"
    if ($state -ne "Enabled") {
        throw "GATE: la suscripción activa no está Enabled."
    }
    foreach ($namespace in $ProviderNamespaces) {
        $registration = Get-AzValue @("provider", "show", "--namespace", $namespace, "--query", "registrationState", "-o", "tsv") -Operation "provider $namespace"
        if ($registration -ne "Registered") {
            throw "GATE: el provider $namespace no está registrado (permisos/quota no verificados)."
        }
    }
}

function Wait-AzJobSucceeded {
    param([string]$JobName, [int]$TimeoutSeconds = 900)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $status = Get-AzValue @(
            "containerapp", "job", "execution", "list",
            "--name", $JobName,
            "--resource-group", $rgName,
            "--query", "[0].properties.status", "-o", "tsv"
        ) -Operation "job execution $JobName"
        if ($status -eq "Succeeded") { return }
        if ($status -eq "Failed") { throw "El job '$JobName' falló." }
        Start-Sleep -Seconds 10
    }
    throw "Timeout esperando al job '$JobName'."
}

function Invoke-Cleanup {
    $teardown = Join-Path $PSScriptRoot "teardown_azure.ps1"
    if (-not (Test-Path -LiteralPath $teardown)) {
        Write-Warn "No se encontró teardown_azure.ps1; cleanup pendiente."
        $script:Manifest["cleanup"]["status"] = "pending"
        $script:Manifest["cleanup"]["message"] = "teardown script missing"
        Save-Manifest
        return 1
    }
    $shell = (Get-Process -Id $PID).Path
    if (-not $shell) { $shell = (Get-Command pwsh).Source }
    $cleanupArguments = @("-NoProfile", "-NonInteractive")
    if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
        $cleanupArguments += @("-ExecutionPolicy", "Bypass")
    }
    $cleanupArguments += @(
        "-File", $teardown,
        "-ManifestPath", $script:ManifestPath,
        "-TimeoutSeconds", "$CleanupTimeoutSeconds",
        "-PollIntervalSeconds", "$CleanupPollSeconds"
    )
    & $shell @cleanupArguments | Out-Null
    $code = $LASTEXITCODE
    if (Test-Path -LiteralPath $script:ManifestPath) {
        try {
            $fresh = Get-Content -LiteralPath $script:ManifestPath -Raw | ConvertFrom-Json
            $script:Manifest["cleanup"]["status"] = $fresh.cleanup.status
            $script:Manifest["cleanup"]["checkedAt"] = $fresh.cleanup.checkedAt
            $script:Manifest["cleanup"]["residuals"] = @($fresh.cleanup.residuals)
            $script:Manifest["cleanup"]["message"] = $fresh.cleanup.message
        }
        catch {
            Write-Warn "No se pudo releer el estado de cleanup del manifest."
        }
    }
    return $code
}

$exitCode = 0
$primaryError = $null

try {
    Write-Plan
    Assert-DeployGate

    # 1. Resource group ------------------------------------------------------
    if (Test-AzExists @("group", "show", "--name", $rgName)) {
        $rgId = Get-AzValue @("group", "show", "--name", $rgName, "--query", "id", "-o", "tsv") -Operation "group id"
        Assert-RunOwnership "resource group" $rgName $rgId
        Write-Info "Resource group '$rgName' ya existe y pertenece al run."
    }
    else {
        Invoke-AzCli (@("group", "create", "--name", $rgName, "--location", $Location, "--tags") + $tagArgs + @("--output", "none")) -Operation "group create"
        $rgId = Get-AzValue @("group", "show", "--name", $rgName, "--query", "id", "-o", "tsv") -Operation "group id"
        $script:Manifest["resourceGroup"]["createdByRun"] = $true
        $script:CreatedAny = $true
    }
    $script:Manifest["resourceGroup"]["id"] = $rgId
    # The RG is either newly created or already owned by this run; cleanup must
    # consider the run resources even on a re-run.
    $script:CreatedAny = $true
    Save-Manifest

    # 2. Storage account + containers ---------------------------------------
    if (Test-AzExists @("storage", "account", "show", "--name", $StorageName, "--resource-group", $rgName)) {
        $storageId = Get-AzValue @("storage", "account", "show", "--name", $StorageName, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "storage id"
        Assert-RunOwnership "storage account" $StorageName $storageId
    }
    else {
        Invoke-AzCli (@(
            "storage", "account", "create",
            "--name", $StorageName,
            "--resource-group", $rgName,
            "--location", $Location,
            "--sku", "Standard_LRS",
            "--kind", "StorageV2",
            "--min-tls-version", "TLS1_2",
            "--allow-blob-public-access", "false",
            "--tags"
        ) + $tagArgs + @("--output", "none")) -Operation "storage create"
        $storageId = Get-AzValue @("storage", "account", "show", "--name", $StorageName, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "storage id"
        $script:CreatedAny = $true
    }
    Add-ManifestResource -Type "storage" -Name $StorageName -Id $storageId -ResourceTags $tags -Extra @{ containers = $Containers }
    Save-Manifest

    $storageKey = Register-Secret (Get-AzValue @(
        "storage", "account", "keys", "list",
        "--account-name", $StorageName,
        "--resource-group", $rgName,
        "--query", "[0].value", "-o", "tsv"
    ) -Operation "storage key")

    foreach ($container in $Containers) {
        Invoke-AzCli @(
            "storage", "container", "create",
            "--name", $container,
            "--account-name", $StorageName,
            "--account-key", $storageKey,
            "--public-access", "off",
            "--output", "none"
        ) -Operation "storage container $container"
    }

    if ($SkipModelUpload) {
        Write-Warn "Skipping model upload (-SkipModelUpload)."
    }
    elseif (-not (Test-Path -LiteralPath $ModelsDir)) {
        Write-Warn "Models directory '$ModelsDir' not found; skipping upload."
    }
    else {
        $modelFiles = @(Get-ChildItem -LiteralPath $ModelsDir -File -ErrorAction SilentlyContinue)
        if ($modelFiles.Count -eq 0) {
            Write-Warn "No model artifacts found in '$ModelsDir'; skipping upload."
        }
        else {
            Write-Info "Uploading $($modelFiles.Count) artifact(s) to the 'models' container..."
            foreach ($file in $modelFiles) {
                Invoke-AzCli @(
                    "storage", "blob", "upload",
                    "--account-name", $StorageName,
                    "--account-key", $storageKey,
                    "--container-name", "models",
                    "--name", $file.Name,
                    "--file", $file.FullName,
                    "--overwrite",
                    "--only-show-errors",
                    "--output", "none"
                ) -Operation "storage blob upload"
            }
        }
    }

    # 3. Registry + images ---------------------------------------------------
    if (Test-AzExists @("acr", "show", "--name", $acrName, "--resource-group", $rgName)) {
        $acrId = Get-AzValue @("acr", "show", "--name", $acrName, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "acr id"
        Assert-RunOwnership "container registry" $acrName $acrId
        Invoke-AzCli @("acr", "update", "--name", $acrName, "--resource-group", $rgName, "--admin-enabled", "true", "--output", "none") -Operation "acr update"
    }
    else {
        Invoke-AzCli (@(
            "acr", "create",
            "--name", $acrName,
            "--resource-group", $rgName,
            "--location", $Location,
            "--sku", "Basic",
            "--admin-enabled", "true",
            "--tags"
        ) + $tagArgs + @("--output", "none")) -Operation "acr create"
        $acrId = Get-AzValue @("acr", "show", "--name", $acrName, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "acr id"
        $script:CreatedAny = $true
    }
    $acrLoginServer = Get-AzValue @("acr", "show", "--name", $acrName, "--resource-group", $rgName, "--query", "loginServer", "-o", "tsv") -Operation "acr login server"
    Add-ManifestResource -Type "acr" -Name $acrName -Id $acrId -ResourceTags $tags -Extra @{ loginServer = $acrLoginServer }
    Save-Manifest

    $acrUser = Register-Secret (Get-AzValue @("acr", "credential", "show", "--name", $acrName, "--query", "username", "-o", "tsv") -Operation "acr username")
    $acrPass = Register-Secret (Get-AzValue @("acr", "credential", "show", "--name", $acrName, "--query", "passwords[0].value", "-o", "tsv") -Operation "acr password")

    foreach ($key in $imageRefs.Keys) {
        $image = $imageRefs[$key]
        Write-Info "Building $image from $($dockerfiles[$key])..."
        Invoke-AzCli @(
            "acr", "build",
            "--registry", $acrName,
            "--image", $image,
            "--file", $dockerfiles[$key],
            $RepoRoot,
            "--output", "none"
        ) -Operation "acr build $key"
        $digest = Get-AzValue @(
            "acr", "repository", "show",
            "--name", $acrName,
            "--image", $image,
            "--query", "digest", "-o", "tsv"
        ) -Operation "acr digest $key"
        $script:Manifest["images"][$key]["digest"] = $digest
        Save-Manifest
    }

    # 4. PostgreSQL Flexible Server -----------------------------------------
    $pgPassword = ConvertTo-PlainText $PostgresPassword
    if (-not $pgPassword) {
        $pgPassword = New-StrongPassword
        Write-Warn "No PostgreSQL password supplied; generated one in memory (never written to disk)."
    }
    Register-Secret $pgPassword | Out-Null

    if (Test-AzExists @("postgres", "flexible-server", "show", "--name", $PostgresName, "--resource-group", $rgName)) {
        $pgId = Get-AzValue @("postgres", "flexible-server", "show", "--name", $PostgresName, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "postgres id"
        Assert-RunOwnership "postgres server" $PostgresName $pgId
    }
    else {
        Invoke-AzCli (@(
            "postgres", "flexible-server", "create",
            "--resource-group", $rgName,
            "--name", $PostgresName,
            "--location", $Location,
            "--tier", "Burstable",
            "--sku-name", "Standard_B1ms",
            "--storage-size", "32",
            "--version", "16",
            "--admin-user", $PostgresAdmin,
            "--admin-password", $pgPassword,
            "--public-access", "0.0.0.0",
            "--tags"
        ) + $tagArgs + @("--output", "none")) -Operation "postgres create"
        $pgId = Get-AzValue @("postgres", "flexible-server", "show", "--name", $PostgresName, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "postgres id"
        $script:CreatedAny = $true
    }
    $pgHost = Get-AzValue @("postgres", "flexible-server", "show", "--name", $PostgresName, "--resource-group", $rgName, "--query", "fullyQualifiedDomainName", "-o", "tsv") -Operation "postgres host"
    Add-ManifestResource -Type "postgres" -Name $PostgresName -Id $pgId -ResourceTags $tags -Extra @{ host = $pgHost; database = $PostgresDatabase }
    Save-Manifest

    if (-not (Test-AzExists @("postgres", "flexible-server", "db", "show", "--resource-group", $rgName, "--server-name", $PostgresName, "--name", $PostgresDatabase))) {
        Invoke-AzCli @(
            "postgres", "flexible-server", "db", "create",
            "--resource-group", $rgName,
            "--server-name", $PostgresName,
            "--name", $PostgresDatabase,
            "--output", "none"
        ) -Operation "postgres db create"
    }
    if (-not (Test-AzExists @("postgres", "flexible-server", "firewall-rule", "show", "--resource-group", $rgName, "--server-name", $PostgresName, "--name", "AllowAzureServices"))) {
        Invoke-AzCli @(
            "postgres", "flexible-server", "firewall-rule", "create",
            "--resource-group", $rgName,
            "--server-name", $PostgresName,
            "--name", "AllowAzureServices",
            "--start-ip-address", "0.0.0.0",
            "--end-ip-address", "0.0.0.0",
            "--output", "none"
        ) -Operation "postgres firewall"
    }

    # 5. Redis ---------------------------------------------------------------
    if (Test-AzExists @("redis", "show", "--name", $RedisName, "--resource-group", $rgName)) {
        $redisId = Get-AzValue @("redis", "show", "--name", $RedisName, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "redis id"
        Assert-RunOwnership "redis" $RedisName $redisId
    }
    else {
        Invoke-AzCli (@(
            "redis", "create",
            "--name", $RedisName,
            "--resource-group", $rgName,
            "--location", $Location,
            "--sku", "Basic",
            "--vm-size", "c0",
            "--tags"
        ) + $tagArgs + @("--output", "none")) -Operation "redis create"
        $redisId = Get-AzValue @("redis", "show", "--name", $RedisName, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "redis id"
        $script:CreatedAny = $true
    }
    $redisHost = Get-AzValue @("redis", "show", "--name", $RedisName, "--resource-group", $rgName, "--query", "hostName", "-o", "tsv") -Operation "redis host"
    Add-ManifestResource -Type "redis" -Name $RedisName -Id $redisId -ResourceTags $tags -Extra @{ host = $redisHost }
    Save-Manifest

    $redisPrimaryKey = Register-Secret (Get-AzValue @("redis", "list-keys", "--name", $RedisName, "--resource-group", $rgName, "--query", "primaryKey", "-o", "tsv") -Operation "redis key")

    # 6. Container Apps environment -----------------------------------------
    if (Test-AzExists @("containerapp", "env", "show", "--name", $EnvName, "--resource-group", $rgName)) {
        $envId = Get-AzValue @("containerapp", "env", "show", "--name", $EnvName, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "env id"
        Assert-RunOwnership "container apps environment" $EnvName $envId
    }
    else {
        Invoke-AzCli (@(
            "containerapp", "env", "create",
            "--name", $EnvName,
            "--resource-group", $rgName,
            "--location", $Location,
            "--tags"
        ) + $tagArgs + @("--output", "none")) -Operation "env create"
        $envId = Get-AzValue @("containerapp", "env", "show", "--name", $EnvName, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "env id"
        $script:CreatedAny = $true
    }
    Add-ManifestResource -Type "containerapp.env" -Name $EnvName -Id $envId -ResourceTags $tags
    Save-Manifest

    # 7. Derived configuration (secrets stay in memory / Container App secrets).
    $databaseUrl = "postgresql://${PostgresAdmin}:${pgPassword}@${pgHost}:5432/${PostgresDatabase}?sslmode=require"
    $redisUrl = "rediss://:${redisPrimaryKey}@${redisHost}:6380/0"
    $jwtSecret = Register-Secret (New-StrongToken 48)
    $exportSecret = Register-Secret (New-StrongToken 48)
    $mlToken = Register-Secret (New-StrongToken 40)
    Register-Secret $databaseUrl | Out-Null
    Register-Secret $redisUrl | Out-Null

    $commonBuckets = @(
        "STORAGE_PROVIDER=azure",
        "STORAGE_ID=azure-blob-default",
        "AZURE_STORAGE_ACCOUNT_URL=https://$StorageName.blob.core.windows.net",
        "AZURE_STORAGE_ACCOUNT_NAME=$StorageName",
        "MINIO_BUCKET_RAW=raw-retinas",
        "MINIO_BUCKET_GRADCAM=gradcam-overlays",
        "MINIO_BUCKET_MASK=segmentation-masks",
        "MINIO_BUCKET_OVERLAY=segmentation-overlays",
        "MINIO_BUCKET_PDF=clinical-reports",
        "STORAGE_ALLOWED_BUCKETS=raw-retinas,gradcam-overlays,segmentation-masks,segmentation-overlays,clinical-reports",
        "STORAGE_DOWNLOAD_TTL_SECONDS=3600"
    )

    # 8. Manual jobs: migrate then bootstrap --------------------------------
    Invoke-AzCli (@(
        "containerapp", "job", "create",
        "--name", $MigrateJob,
        "--resource-group", $rgName,
        "--environment", $EnvName,
        "--trigger-type", "Manual",
        "--replica-timeout", "600",
        "--replica-retry-limit", "1",
        "--image", $imageRefs["migrate"],
        "--registry-server", $acrLoginServer,
        "--registry-username", $acrUser,
        "--registry-password", $acrPass,
        "--cpu", "0.5",
        "--memory", "1.0Gi",
        "--secrets", "database-url=$databaseUrl",
        "--env-vars", "NODE_ENV=production", "DATABASE_URL=secretref:database-url",
        "--tags"
    ) + $tagArgs + @("--output", "none")) -Operation "job create migrate"
    $migrateJobId = Get-AzValue @("containerapp", "job", "show", "--name", $MigrateJob, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "job id migrate"
    Add-ManifestResource -Type "containerapp.job" -Name $MigrateJob -Id $migrateJobId -ResourceTags $tags -Extra @{ purpose = "prisma:deploy" }
    $script:CreatedAny = $true
    Save-Manifest

    Invoke-AzCli @("containerapp", "job", "start", "--name", $MigrateJob, "--resource-group", $rgName, "--output", "none") -Operation "job start migrate"
    Wait-AzJobSucceeded -JobName $MigrateJob
    $script:Manifest["jobs"]["migrate"] = "succeeded"
    Save-Manifest

    $bootstrapPassword = ConvertTo-PlainText $BootstrapAdminPassword
    if ($BootstrapAdminEmail -and $bootstrapPassword) {
        Register-Secret $bootstrapPassword | Out-Null
        Invoke-AzCli (@(
            "containerapp", "job", "create",
            "--name", $BootstrapJob,
            "--resource-group", $rgName,
            "--environment", $EnvName,
            "--trigger-type", "Manual",
            "--replica-timeout", "600",
            "--replica-retry-limit", "0",
            "--image", $imageRefs["backend"],
            "--registry-server", $acrLoginServer,
            "--registry-username", $acrUser,
            "--registry-password", $acrPass,
            "--cpu", "0.5",
            "--memory", "1.0Gi",
            "--command", "npm", "run", "admin:bootstrap",
            "--secrets", "database-url=$databaseUrl", "bootstrap-admin-password=$bootstrapPassword",
            "--env-vars", "NODE_ENV=production", "DATABASE_URL=secretref:database-url",
            "BOOTSTRAP_ADMIN_EMAIL=$BootstrapAdminEmail",
            "BOOTSTRAP_ADMIN_PASSWORD=secretref:bootstrap-admin-password",
            "--tags"
        ) + $tagArgs + @("--output", "none")) -Operation "job create bootstrap"
        $bootstrapJobId = Get-AzValue @("containerapp", "job", "show", "--name", $BootstrapJob, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "job id bootstrap"
        Add-ManifestResource -Type "containerapp.job" -Name $BootstrapJob -Id $bootstrapJobId -ResourceTags $tags -Extra @{ purpose = "admin:bootstrap" }
        $script:CreatedAny = $true
        Save-Manifest

        Invoke-AzCli @("containerapp", "job", "start", "--name", $BootstrapJob, "--resource-group", $rgName, "--output", "none") -Operation "job start bootstrap"
        Wait-AzJobSucceeded -JobName $BootstrapJob
        $script:Manifest["jobs"]["bootstrap"] = "succeeded"
    }
    else {
        Write-Warn "Bootstrap admin omitido: pase -BootstrapAdminEmail y -BootstrapAdminPassword (SecureString)."
        $script:Manifest["jobs"]["bootstrap"] = "skipped-missing-credentials"
    }
    Save-Manifest

    # 9. ML service ----------------------------------------------------------
    $mlSecrets = @("azure-storage-key=$storageKey", "ml-api-token=$mlToken")
    $mlEnv = @(
        "ML_INFERENCE_BACKEND=onnx",
        "ML_DEVICE=cpu",
        "ML_HOST=0.0.0.0",
        "ML_PORT=8000",
        "ML_MINIO_REQUIRED=false",
        "ML_MINIO_SECURE=true",
        "ML_MINIO_ENDPOINT=https://$StorageName.blob.core.windows.net",
        "ML_MINIO_ACCESS_KEY=$StorageName",
        "ML_MINIO_SECRET_KEY=secretref:azure-storage-key",
        "ML_MASK_BUCKET=segmentation-masks",
        "ML_OVERLAY_BUCKET=segmentation-overlays",
        "ML_ALLOW_HTTP_SIGNED_URLS=false",
        "ML_ALLOWED_SIGNED_URL_HOSTS=*.blob.core.windows.net",
        "ML_MODEL_CACHE_DIR=/models",
        "ML_MANIFEST_PATH=/app/ml/models/manifest.json",
        "ML_API_TOKEN=secretref:ml-api-token"
    )
    if (Test-AzExists @("containerapp", "show", "--name", $MlApp, "--resource-group", $rgName)) {
        $mlAppId = Get-AzValue @("containerapp", "show", "--name", $MlApp, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "ml app id"
        Assert-RunOwnership "container app" $MlApp $mlAppId
    }
    else {
        Invoke-AzCli (@(
            "containerapp", "create",
            "--name", $MlApp,
            "--resource-group", $rgName,
            "--environment", $EnvName,
            "--image", $imageRefs["ml-service"],
            "--registry-server", $acrLoginServer,
            "--registry-username", $acrUser,
            "--registry-password", $acrPass,
            "--target-port", "8000",
            "--ingress", "external",
            "--transport", "http",
            "--cpu", "1.0",
            "--memory", "2.0Gi",
            "--min-replicas", "0",
            "--max-replicas", "1",
            "--secrets"
        ) + $mlSecrets + @("--env-vars") + $mlEnv + @("--tags") + $tagArgs + @("--output", "none")) -Operation "containerapp create ml"
        $mlAppId = Get-AzValue @("containerapp", "show", "--name", $MlApp, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "ml app id"
        $script:CreatedAny = $true
    }
    $mlFqdn = Get-AzValue @("containerapp", "show", "--name", $MlApp, "--resource-group", $rgName, "--query", "properties.configuration.ingress.fqdn", "-o", "tsv") -Operation "ml app fqdn"
    $script:Manifest["endpoints"]["ml"] = "https://$mlFqdn"
    Add-ManifestResource -Type "containerapp" -Name $MlApp -Id $mlAppId -ResourceTags $tags -Extra @{ image = $imageRefs["ml-service"]; fqdn = "https://$mlFqdn" }
    Save-Manifest

    # 10. Backend ------------------------------------------------------------
    $backendSecrets = @(
        "database-url=$databaseUrl",
        "azure-storage-key=$storageKey",
        "jwt-secret=$jwtSecret",
        "export-hmac-secret=$exportSecret",
        "ml-api-token=$mlToken",
        "redis-url=$redisUrl"
    )
    $backendEnv = @(
        "NODE_ENV=production",
        "PORT=8000",
        "DATABASE_URL=secretref:database-url",
        "AZURE_STORAGE_ACCOUNT_KEY=secretref:azure-storage-key",
        "JWT_SECRET=secretref:jwt-secret",
        "EXPORT_HMAC_SECRET=secretref:export-hmac-secret",
        "ML_API_TOKEN=secretref:ml-api-token",
        "REDIS_URL=secretref:redis-url",
        "ML_SERVICE_URL=https://$mlFqdn"
    ) + $commonBuckets
    if (Test-AzExists @("containerapp", "show", "--name", $BackendApp, "--resource-group", $rgName)) {
        $backendAppId = Get-AzValue @("containerapp", "show", "--name", $BackendApp, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "backend app id"
        Assert-RunOwnership "container app" $BackendApp $backendAppId
    }
    else {
        Invoke-AzCli (@(
            "containerapp", "create",
            "--name", $BackendApp,
            "--resource-group", $rgName,
            "--environment", $EnvName,
            "--image", $imageRefs["backend"],
            "--registry-server", $acrLoginServer,
            "--registry-username", $acrUser,
            "--registry-password", $acrPass,
            "--target-port", "8000",
            "--ingress", "external",
            "--transport", "http",
            "--cpu", "0.5",
            "--memory", "1.0Gi",
            "--min-replicas", "1",
            "--max-replicas", "2",
            "--secrets"
        ) + $backendSecrets + @("--env-vars") + $backendEnv + @("--tags") + $tagArgs + @("--output", "none")) -Operation "containerapp create backend"
        $backendAppId = Get-AzValue @("containerapp", "show", "--name", $BackendApp, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "backend app id"
        $script:CreatedAny = $true
    }
    $backendFqdn = Get-AzValue @("containerapp", "show", "--name", $BackendApp, "--resource-group", $rgName, "--query", "properties.configuration.ingress.fqdn", "-o", "tsv") -Operation "backend app fqdn"
    $script:Manifest["endpoints"]["backend"] = "https://$backendFqdn"
    Add-ManifestResource -Type "containerapp" -Name $BackendApp -Id $backendAppId -ResourceTags $tags -Extra @{ image = $imageRefs["backend"]; fqdn = "https://$backendFqdn" }
    Save-Manifest

    # Cookie endpoints fail closed without AUTH_PUBLIC_ORIGIN. The run E2E sends
    # Origin = backend base URL, so use the real backend FQDN. CORS_ORIGIN is
    # intentionally left unset for this API-only run; a browser UI would need
    # CORS_ORIGIN=https://<frontend FQDN>.
    Invoke-AzCli @(
        "containerapp", "update",
        "--name", $BackendApp,
        "--resource-group", $rgName,
        "--set-env-vars", "AUTH_PUBLIC_ORIGIN=https://$backendFqdn",
        "--output", "none"
    ) -Operation "containerapp update backend public origin"
    Save-Manifest

    # 11. Worker -------------------------------------------------------------
    $workerSecrets = @(
        "database-url=$databaseUrl",
        "azure-storage-key=$storageKey",
        "ml-api-token=$mlToken",
        "redis-url=$redisUrl"
    )
    $workerEnv = @(
        "NODE_ENV=production",
        "DATABASE_URL=secretref:database-url",
        "AZURE_STORAGE_ACCOUNT_KEY=secretref:azure-storage-key",
        "ML_API_TOKEN=secretref:ml-api-token",
        "REDIS_URL=secretref:redis-url",
        "ML_SERVICE_URL=https://$mlFqdn"
    ) + $commonBuckets
    if (Test-AzExists @("containerapp", "show", "--name", $WorkerApp, "--resource-group", $rgName)) {
        $workerAppId = Get-AzValue @("containerapp", "show", "--name", $WorkerApp, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "worker app id"
        Assert-RunOwnership "container app" $WorkerApp $workerAppId
    }
    else {
        Invoke-AzCli (@(
            "containerapp", "create",
            "--name", $WorkerApp,
            "--resource-group", $rgName,
            "--environment", $EnvName,
            "--image", $imageRefs["worker"],
            "--registry-server", $acrLoginServer,
            "--registry-username", $acrUser,
            "--registry-password", $acrPass,
            "--cpu", "0.5",
            "--memory", "1.0Gi",
            "--min-replicas", "0",
            "--max-replicas", "1",
            "--secrets"
        ) + $workerSecrets + @("--env-vars") + $workerEnv + @("--tags") + $tagArgs + @("--output", "none")) -Operation "containerapp create worker"
        $workerAppId = Get-AzValue @("containerapp", "show", "--name", $WorkerApp, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "worker app id"
        $script:CreatedAny = $true
    }
    Add-ManifestResource -Type "containerapp" -Name $WorkerApp -Id $workerAppId -ResourceTags $tags -Extra @{ image = $imageRefs["worker"] }
    Save-Manifest

    # 12. Frontend -----------------------------------------------------------
    $frontendEnv = @(
        "NODE_ENV=production",
        "NEXT_PUBLIC_API_BASE_URL=https://$backendFqdn",
        "API_BASE_URL=https://$backendFqdn"
    )
    if (Test-AzExists @("containerapp", "show", "--name", $FrontendApp, "--resource-group", $rgName)) {
        $frontendAppId = Get-AzValue @("containerapp", "show", "--name", $FrontendApp, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "frontend app id"
        Assert-RunOwnership "container app" $FrontendApp $frontendAppId
    }
    else {
        Invoke-AzCli (@(
            "containerapp", "create",
            "--name", $FrontendApp,
            "--resource-group", $rgName,
            "--environment", $EnvName,
            "--image", $imageRefs["frontend"],
            "--registry-server", $acrLoginServer,
            "--registry-username", $acrUser,
            "--registry-password", $acrPass,
            "--target-port", "3000",
            "--ingress", "external",
            "--transport", "http",
            "--cpu", "0.5",
            "--memory", "1.0Gi",
            "--min-replicas", "0",
            "--max-replicas", "1",
            "--env-vars"
        ) + $frontendEnv + @("--tags") + $tagArgs + @("--output", "none")) -Operation "containerapp create frontend"
        $frontendAppId = Get-AzValue @("containerapp", "show", "--name", $FrontendApp, "--resource-group", $rgName, "--query", "id", "-o", "tsv") -Operation "frontend app id"
        $script:CreatedAny = $true
    }
    $frontendFqdn = Get-AzValue @("containerapp", "show", "--name", $FrontendApp, "--resource-group", $rgName, "--query", "properties.configuration.ingress.fqdn", "-o", "tsv") -Operation "frontend app fqdn"
    $script:Manifest["endpoints"]["frontend"] = "https://$frontendFqdn"
    Add-ManifestResource -Type "containerapp" -Name $FrontendApp -Id $frontendAppId -ResourceTags $tags -Extra @{ image = $imageRefs["frontend"]; fqdn = "https://$frontendFqdn" }
    Save-Manifest

    Write-Info "Deployment applied. Manifest: $script:ManifestPath"
}
catch {
    $primaryError = $_.Exception.Message
    Write-Host ("[clearsight] ERROR: {0}" -f (Protect-Message $primaryError)) -ForegroundColor Red
    $exitCode = 1
}
finally {
    if ($Apply) {
        if ($KeepForDebug) {
            Write-Warn "Cleanup omitido por -KeepForDebug. Expira: $expiresAt."
            Write-Warn "Ejecute: pwsh ./scripts/teardown_azure.ps1 -ManifestPath `"$script:ManifestPath`""
            $script:Manifest["cleanup"]["status"] = "skipped-keep-for-debug"
            $script:Manifest["cleanup"]["message"] = "explicit -KeepForDebug"
            Save-Manifest
        }
        elseif (-not $script:CreatedAny) {
            $script:Manifest["cleanup"]["status"] = "not-needed"
            $script:Manifest["cleanup"]["message"] = "no resources created by run"
            Save-Manifest
        }
        else {
            Write-Info "Cleanup en finally desde el manifest..."
            try {
                $cleanupCode = Invoke-Cleanup
                if ($cleanupCode -ne 0) {
                    Write-Warn "Cleanup pendiente (exit $cleanupCode). Revise el manifest."
                    $exitCode = 1
                }
                else {
                    Write-Info "Cleanup verificado sin residuos."
                }
            }
            catch {
                Write-Warn ("Cleanup falló: {0}" -f (Protect-Message $_.Exception.Message))
                $script:Manifest["cleanup"]["status"] = "pending"
                $script:Manifest["cleanup"]["message"] = "cleanup invocation failed"
                Save-Manifest
                $exitCode = 1
            }
        }
    }
}

if ($primaryError) {
    exit $exitCode
}
Write-Info "Run finalizado. Estado cleanup: $($script:Manifest['cleanup']['status'])."
exit $exitCode
