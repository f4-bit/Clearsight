#Requires -Version 5.1
<#
.SYNOPSIS
    Idempotent Azure provisioning for the Clearsight ML inference stack.

.DESCRIPTION
    Provisions, in order, the resources required to run Clearsight on the
    "Azure for Students" subscription in a low-cost SKU profile:

      1. Resource group          (rg-clearsight-eastus2 / eastus2)
      2. Storage account         (Standard_LRS, private containers)
      3. Model upload            (models_cache/ -> "models" container)
      4. Azure Container Registry (Basic SKU)
      5. PostgreSQL Flexible Server (Burstable Standard_B1ms, docker/init.sql)
      6. Azure Container Apps    (ml-service, ML_INFERENCE_BACKEND=onnx)

    Every step checks for the resource before creating it, so the script can be
    re-executed safely. A consolidated `.env.azure` file with connection strings
    and endpoints is written to the repository root when the deployment
    finishes.

.PARAMETER PostgresPassword
    Admin password for the PostgreSQL Flexible Server. Generated when omitted
    and persisted only inside `.env.azure`.

.EXAMPLE
    az login
    pwsh ./scripts/deploy_azure.ps1 -StorageAccount clearsightstore123

.EXAMPLE
    pwsh ./scripts/deploy_azure.ps1 -SkipImageBuild -SkipModelUpload
#>
[CmdletBinding()]
param(
    [string]$ResourceGroup = "rg-clearsight-eastus2",
    [string]$Location = "eastus2",
    [string]$StorageAccount = "",
    [string]$AcrName = "",
    [string]$PostgresServer = "",
    [string]$PostgresAdmin = "clearsightadmin",
    [string]$PostgresPassword = "",
    [string]$PostgresDatabase = "clearsight",
    [string]$ContainerAppEnv = "clearsight-env",
    [string]$ContainerAppName = "clearsight-ml-service",
    [string]$ImageTag = "latest",
    [string]$ModelsDir = "",
    [string]$InitSqlPath = "",
    [string]$EnvOutputPath = "",
    [switch]$SkipImageBuild,
    [switch]$SkipModelUpload
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ModelsDir) { $ModelsDir = Join-Path $RepoRoot "models_cache" }
if (-not $InitSqlPath) { $InitSqlPath = Join-Path $RepoRoot "docker/init.sql" }
if (-not $EnvOutputPath) { $EnvOutputPath = Join-Path $RepoRoot ".env.azure" }

$Containers = @(
    "raw-retinas",
    "segmentation-masks",
    "segmentation-overlays",
    "gradcam-overlays",
    "models"
)

function Write-Info([string]$Message) {
    Write-Host "[clearsight] $Message" -ForegroundColor Cyan
}

function Write-Warn([string]$Message) {
    Write-Host "[clearsight] $Message" -ForegroundColor Yellow
}

function Get-DeterministicSuffix([string]$Seed) {
    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Seed)
        $hash = $sha1.ComputeHash($bytes)
    }
    finally {
        $sha1.Dispose()
    }
    $hex = ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLowerInvariant()
    return $hex.Substring(0, 8)
}

function New-StrongPassword {
    $raw = ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N"))
    return "Aa1!" + $raw.Substring(0, 20)
}

function Invoke-AzCli {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    & az @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI command failed (exit $LASTEXITCODE): az $($Arguments -join ' ')"
    }
}

function Test-Exists {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    & az @Arguments 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

function Get-AzValue {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $value = & az @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI query failed (exit $LASTEXITCODE): az $($Arguments -join ' ')"
    }
    return "$value".Trim()
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI (az) was not found on PATH. Install it from https://aka.ms/azure-cli."
}

$suffix = Get-DeterministicSuffix $ResourceGroup
if (-not $StorageAccount) { $StorageAccount = "clearsight$suffix" }
if (-not $AcrName) { $AcrName = "clearsightacr$suffix" }
if (-not $PostgresServer) { $PostgresServer = "clearsight-pg-$suffix" }
if (-not $PostgresPassword) {
    $PostgresPassword = New-StrongPassword
    Write-Warn "No PostgreSQL password supplied; a random one was generated and will be written to $EnvOutputPath."
}

# 1. Authentication -----------------------------------------------------------
Write-Info "Validating Azure CLI authentication..."
$subscriptionId = Get-AzValue @("account", "show", "--query", "id", "-o", "tsv")
if (-not $subscriptionId) {
    throw "Azure CLI is not authenticated. Run 'az login' before deploying."
}
$subscriptionName = Get-AzValue @("account", "show", "--query", "name", "-o", "tsv")
Write-Info "Authenticated to subscription '$subscriptionName' ($subscriptionId)."

# 2. Resource group -----------------------------------------------------------
Write-Info "Ensuring resource group '$ResourceGroup' in '$Location'..."
if (-not (Test-Exists @("group", "show", "--name", $ResourceGroup))) {
    Invoke-AzCli @("group", "create", "--name", $ResourceGroup, "--location", $Location, "--output", "none")
}
else {
    Write-Info "Resource group already exists."
}

# 3. Storage account and containers ------------------------------------------
Write-Info "Ensuring storage account '$StorageAccount' (Standard_LRS)..."
if (-not (Test-Exists @("storage", "account", "show", "--name", $StorageAccount, "--resource-group", $ResourceGroup))) {
    Invoke-AzCli @(
        "storage", "account", "create",
        "--name", $StorageAccount,
        "--resource-group", $ResourceGroup,
        "--location", $Location,
        "--sku", "Standard_LRS",
        "--kind", "StorageV2",
        "--min-tls-version", "TLS1_2",
        "--allow-blob-public-access", "false",
        "--output", "none"
    )
}
else {
    Write-Info "Storage account already exists."
}
$storageKey = Get-AzValue @(
    "storage", "account", "keys", "list",
    "--account-name", $StorageAccount,
    "--resource-group", $ResourceGroup,
    "--query", "[0].value", "-o", "tsv"
)

foreach ($container in $Containers) {
    Invoke-AzCli @(
        "storage", "container", "create",
        "--name", $container,
        "--account-name", $StorageAccount,
        "--account-key", $storageKey,
        "--public-access", "off",
        "--output", "none"
    )
}
Write-Info "Blob containers ready: $($Containers -join ', ')."

# 4. Model upload -------------------------------------------------------------
if ($SkipModelUpload) {
    Write-Warn "Skipping model upload (-SkipModelUpload)."
}
elseif (-not (Test-Path -LiteralPath $ModelsDir)) {
    Write-Warn "Models directory '$ModelsDir' not found; skipping upload."
}
else {
    $modelFiles = Get-ChildItem -LiteralPath $ModelsDir -File -ErrorAction SilentlyContinue
    if (-not $modelFiles -or $modelFiles.Count -eq 0) {
        Write-Warn "No model artifacts found in '$ModelsDir'; skipping upload."
    }
    else {
        Write-Info "Uploading $($modelFiles.Count) artifact(s) to the 'models' container..."
        foreach ($file in $modelFiles) {
            Invoke-AzCli @(
                "storage", "blob", "upload",
                "--account-name", $StorageAccount,
                "--account-key", $storageKey,
                "--container-name", "models",
                "--name", $file.Name,
                "--file", $file.FullName,
                "--overwrite",
                "--only-show-errors"
            )
        }
    }
}

# 5. Azure Container Registry -------------------------------------------------
Write-Info "Ensuring Azure Container Registry '$AcrName' (Basic)..."
if (-not (Test-Exists @("acr", "show", "--name", $AcrName, "--resource-group", $ResourceGroup))) {
    Invoke-AzCli @(
        "acr", "create",
        "--name", $AcrName,
        "--resource-group", $ResourceGroup,
        "--location", $Location,
        "--sku", "Basic",
        "--admin-enabled", "true",
        "--output", "none"
    )
}
else {
    Invoke-AzCli @("acr", "update", "--name", $AcrName, "--admin-enabled", "true", "--output", "none")
}
$acrLoginServer = Get-AzValue @("acr", "show", "--name", $AcrName, "--query", "loginServer", "-o", "tsv")

if ($SkipImageBuild) {
    Write-Warn "Skipping container image build (-SkipImageBuild)."
}
else {
    Write-Info "Building 'clearsight-ml-service:$ImageTag' with ACR Tasks..."
    Invoke-AzCli @(
        "acr", "build",
        "--registry", $AcrName,
        "--image", "clearsight-ml-service:$ImageTag",
        "--file", "docker/ml-service.Dockerfile",
        $RepoRoot
    )
}

# 6. PostgreSQL Flexible Server ----------------------------------------------
Write-Info "Ensuring PostgreSQL Flexible Server '$PostgresServer'..."
if (-not (Test-Exists @("postgres", "flexible-server", "show", "--resource-group", $ResourceGroup, "--name", $PostgresServer))) {
    Invoke-AzCli @(
        "postgres", "flexible-server", "create",
        "--resource-group", $ResourceGroup,
        "--name", $PostgresServer,
        "--location", $Location,
        "--tier", "Burstable",
        "--sku-name", "Standard_B1ms",
        "--storage-size", "32",
        "--version", "16",
        "--admin-user", $PostgresAdmin,
        "--admin-password", $PostgresPassword,
        "--public-access", "0.0.0.0",
        "--output", "none"
    )
}
else {
    Write-Info "PostgreSQL server already exists."
}

if (-not (Test-Exists @("postgres", "flexible-server", "db", "show", "--resource-group", $ResourceGroup, "--server-name", $PostgresServer, "--name", $PostgresDatabase))) {
    Invoke-AzCli @(
        "postgres", "flexible-server", "db", "create",
        "--resource-group", $ResourceGroup,
        "--server-name", $PostgresServer,
        "--name", $PostgresDatabase,
        "--output", "none"
    )
}

Invoke-AzCli @(
    "postgres", "flexible-server", "firewall-rule", "create",
    "--resource-group", $ResourceGroup,
    "--server-name", $PostgresServer,
    "--name", "AllowAzureServices",
    "--start-ip-address", "0.0.0.0",
    "--end-ip-address", "0.0.0.0",
    "--output", "none"
)

Write-Info "Applying schema from '$InitSqlPath'..."
if (-not (Test-Path -LiteralPath $InitSqlPath)) {
    throw "Schema file '$InitSqlPath' was not found."
}
Invoke-AzCli @(
    "postgres", "flexible-server", "execute",
    "--resource-group", $ResourceGroup,
    "--name", $PostgresServer,
    "--database-name", $PostgresDatabase,
    "--admin-user", $PostgresAdmin,
    "--admin-password", $PostgresPassword,
    "--file-path", $InitSqlPath,
    "--output", "none"
)

$postgresHost = "$PostgresServer.postgres.database.azure.com"

# 7. Azure Container Apps -----------------------------------------------------
Write-Info "Ensuring Container Apps environment '$ContainerAppEnv'..."
if (-not (Test-Exists @("containerapp", "env", "show", "--name", $ContainerAppEnv, "--resource-group", $ResourceGroup))) {
    Invoke-AzCli @(
        "containerapp", "env", "create",
        "--name", $ContainerAppEnv,
        "--resource-group", $ResourceGroup,
        "--location", $Location,
        "--output", "none"
    )
}

$acrCredentials = (Invoke-AzCli @("acr", "credential", "show", "--name", $AcrName, "--output", "json")) | Out-String | ConvertFrom-Json
$acrUsername = $acrCredentials.username
$acrPassword = $acrCredentials.passwords[0].value
if (-not $acrUsername -or -not $acrPassword) {
    throw "Unable to read admin credentials for registry '$AcrName'."
}

$image = "$acrLoginServer/clearsight-ml-service:$ImageTag"
$envVars = @(
    "ML_INFERENCE_BACKEND=onnx",
    "ML_DEVICE=cpu",
    "ML_HOST=0.0.0.0",
    "ML_PORT=8000",
    "ML_MINIO_REQUIRED=true",
    "ML_MINIO_SECURE=true",
    "ML_MINIO_ENDPOINT=https://$StorageAccount.blob.core.windows.net",
    "ML_MINIO_ACCESS_KEY=$StorageAccount",
    "ML_MINIO_SECRET_KEY=$storageKey",
    "ML_MASK_BUCKET=segmentation-masks",
    "ML_OVERLAY_BUCKET=segmentation-overlays",
    "ML_ALLOW_HTTP_SIGNED_URLS=false",
    "ML_ALLOWED_SIGNED_URL_HOSTS=*.blob.core.windows.net",
    "ML_MODEL_CACHE_DIR=/models",
    "ML_MANIFEST_PATH=/app/ml/models/manifest.json"
)

Write-Info "Ensuring Container App '$ContainerAppName'..."
if (-not (Test-Exists @("containerapp", "show", "--name", $ContainerAppName, "--resource-group", $ResourceGroup))) {
    Invoke-AzCli (@(
        "containerapp", "create",
        "--name", $ContainerAppName,
        "--resource-group", $ResourceGroup,
        "--environment", $ContainerAppEnv,
        "--image", $image,
        "--registry-server", $acrLoginServer,
        "--registry-username", $acrUsername,
        "--registry-password", $acrPassword,
        "--target-port", "8000",
        "--ingress", "external",
        "--transport", "http",
        "--cpu", "0.5",
        "--memory", "1.0Gi",
        "--min-replicas", "0",
        "--max-replicas", "1",
        "--env-vars"
    ) + $envVars + @("--output", "none"))
}
else {
    Invoke-AzCli (@(
        "containerapp", "update",
        "--name", $ContainerAppName,
        "--resource-group", $ResourceGroup,
        "--image", $image,
        "--registry-server", $acrLoginServer,
        "--registry-username", $acrUsername,
        "--registry-password", $acrPassword,
        "--min-replicas", "0",
        "--max-replicas", "1",
        "--env-vars"
    ) + $envVars + @("--output", "none"))
}

$fqdn = Get-AzValue @(
    "containerapp", "show",
    "--name", $ContainerAppName,
    "--resource-group", $ResourceGroup,
    "--query", "properties.configuration.ingress.fqdn", "-o", "tsv"
)
$baseUrl = "https://$fqdn"
$storageConnectionString = Get-AzValue @(
    "storage", "account", "show-connection-string",
    "--name", $StorageAccount,
    "--resource-group", $ResourceGroup, "-o", "tsv"
)
$databaseUrl = "postgresql://${PostgresAdmin}:${PostgresPassword}@${postgresHost}:5432/${PostgresDatabase}?sslmode=require"

# 8. Consolidated environment file -------------------------------------------
Write-Info "Writing consolidated configuration to '$EnvOutputPath'..."
$envLines = @(
    "# Generated by scripts/deploy_azure.ps1 on $(Get-Date -Format o)",
    "CLEARSIGHT_API_BASE_URL=$baseUrl",
    "STORAGE_ACCOUNT_NAME=$StorageAccount",
    "AZURE_STORAGE_CONNECTION_STRING=$storageConnectionString",
    "AZURE_STORAGE_BLOB_ENDPOINT=https://$StorageAccount.blob.core.windows.net",
    "DATABASE_URL=$databaseUrl",
    "POSTGRES_HOST=$postgresHost",
    "POSTGRES_DB=$PostgresDatabase",
    "POSTGRES_USER=$PostgresAdmin",
    "POSTGRES_PASSWORD=$PostgresPassword",
    "ACR_LOGIN_SERVER=$acrLoginServer",
    "CONTAINER_APP_FQDN=$fqdn",
    "CONTAINER_APP_NAME=$ContainerAppName",
    "ML_INFERENCE_BACKEND=onnx",
    "ML_MINIO_ENDPOINT=https://$StorageAccount.blob.core.windows.net",
    "ML_MINIO_ACCESS_KEY=$StorageAccount",
    "ML_MINIO_SECRET_KEY=$storageKey",
    "ML_MASK_BUCKET=segmentation-masks",
    "ML_OVERLAY_BUCKET=segmentation-overlays",
    "ML_ALLOWED_SIGNED_URL_HOSTS=*.blob.core.windows.net"
)
Set-Content -LiteralPath $EnvOutputPath -Value $envLines -Encoding UTF8

# 9. Deployment summary -------------------------------------------------------
Write-Info "Deployment complete."
Write-Host ""
Write-Host "  Resource group : $ResourceGroup ($Location)"
Write-Host "  Storage        : $StorageAccount"
Write-Host "  Registry       : $acrLoginServer"
Write-Host "  PostgreSQL     : $postgresHost/$PostgresDatabase"
Write-Host "  Inference URL  : $baseUrl"
Write-Host "  Health         : $baseUrl/health/ready"
Write-Host "  Configuration  : $EnvOutputPath"
Write-Host ""
Write-Info "Run 'python scripts/test_azure_e2e.py --base-url $baseUrl' to verify the pipeline."
