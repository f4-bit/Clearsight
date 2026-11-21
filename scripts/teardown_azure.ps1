#Requires -Version 5.1
<#
.SYNOPSIS
    Ownership-checked teardown for a Clearsight Azure run.

.DESCRIPTION
    Reads the run manifest written by scripts/deploy_azure.ps1 and deletes only
    resources whose live `runId` tag matches the manifest. Resources without the
    run tag are never deleted; they are reported as `pending`.

    Deletion runs in reverse creation order. `az group delete --no-wait` is used
    only when the resource group was created by the run and its live tags match;
    otherwise resources are deleted one by one. Asynchronous deletion is polled
    with a timeout using `az group exists`, `az resource list`,
    `az postgres flexible-server show`, `az storage account show`, `az acr show`
    and `az containerapp show`. Blobs, soft-deleted containers, ACR images and
    public IPs are reviewed for residuals.

    If anything remains, the manifest cleanup block is updated to `pending` with
    safe identifiers and the script exits non-zero.

.PARAMETER ManifestPath
    Path to `artifacts/azure-runs/<runId>/manifest.json`.

.PARAMETER TimeoutSeconds
    Maximum time to wait for asynchronous deletions (default 300).

.PARAMETER PollIntervalSeconds
    Polling interval (default 10).

.EXAMPLE
    pwsh ./scripts/teardown_azure.ps1 -ManifestPath ./artifacts/azure-runs/run123/manifest.json
#>
[CmdletBinding()]
param(
    [string]$ManifestPath = "",
    [int]$TimeoutSeconds = 300,
    [int]$PollIntervalSeconds = 10
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:AzExe = "az"
$script:Pending = New-Object System.Collections.Generic.List[object]
$script:Residuals = New-Object System.Collections.Generic.List[object]
$script:Deleted = New-Object System.Collections.Generic.List[object]

function Write-Info([string]$Message) {
    Write-Host "[clearsight-teardown] $Message" -ForegroundColor Cyan
}

function Write-Warn([string]$Message) {
    Write-Host "[clearsight-teardown] $Message" -ForegroundColor Yellow
}

function Fail([string]$Message) {
    Write-Host "[clearsight-teardown] BLOQUEO: $Message" -ForegroundColor Red
    exit 1
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

if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    Fail "ManifestPath es obligatorio."
}
if (-not (Test-Path -LiteralPath $ManifestPath)) {
    Fail "Manifest no encontrado: $ManifestPath"
}

try {
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
}
catch {
    Fail "Manifest JSON inválido."
}

if ($null -eq $manifest -or $null -eq $manifest.runId -or -not $manifest.runId) {
    Fail "Manifest sin runId."
}
$manifestRunTag = Get-TagValue $manifest.tags "runId"
if (-not $manifestRunTag -or "$manifestRunTag" -ne "$($manifest.runId)") {
    Fail "Manifest sin tag runId coherente; no se puede demostrar ownership."
}
if ($null -eq $manifest.resourceGroup -or -not $manifest.resourceGroup.name) {
    Fail "Manifest sin resource group."
}

$runId = "$($manifest.runId)"
$rgName = "$($manifest.resourceGroup.name)"
$createdByRun = [bool]$manifest.resourceGroup.createdByRun

$azOverride = [System.Environment]::GetEnvironmentVariable("CLEARSIGHT_AZ_EXE")
if ($azOverride) {
    if (-not (Test-Path -LiteralPath $azOverride)) {
        Fail "CLEARSIGHT_AZ_EXE apunta a una ruta inexistente."
    }
    $script:AzExe = $azOverride
}
elseif (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Fail "Azure CLI (az) no está disponible en PATH."
}

function Invoke-AzCapture {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        $output = & $script:AzExe @Arguments 2>$null
        $code = $LASTEXITCODE
        return [pscustomobject]@{
            ExitCode = $code
            Output   = (($output | Out-String).Trim())
        }
    }
    catch {
        return [pscustomobject]@{ ExitCode = 1; Output = "" }
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

function Get-AzValue {
    param([string[]]$Arguments, [string]$Operation = "az query")
    $result = Invoke-AzCapture -Arguments $Arguments
    if ($result.ExitCode -ne 0) {
        throw "Azure CLI query failed (exit $($result.ExitCode)): $Operation"
    }
    return $result.Output
}

function Test-AzExists {
    param([string[]]$Arguments)
    $result = Invoke-AzCapture -Arguments $Arguments
    return ($result.ExitCode -eq 0)
}

function Get-LiveTags {
    param([string]$Id)
    $result = Invoke-AzCapture -Arguments @("resource", "show", "--ids", $Id, "--query", "tags", "-o", "json")
    if ($result.ExitCode -eq 3) {
        return [pscustomobject]@{ State = "not-found"; Tags = $null }
    }
    if ($result.ExitCode -ne 0) {
        return [pscustomobject]@{ State = "query-failed"; Tags = $null }
    }
    if (-not $result.Output -or $result.Output -eq "null") {
        return [pscustomobject]@{ State = "untagged"; Tags = $null }
    }
    try {
        $tags = $result.Output | ConvertFrom-Json
    }
    catch {
        return [pscustomobject]@{ State = "query-failed"; Tags = $null }
    }
    if ($null -eq $tags) {
        return [pscustomobject]@{ State = "untagged"; Tags = $tags }
    }
    $liveRunId = Get-TagValue $tags "runId"
    if (-not $liveRunId) {
        return [pscustomobject]@{ State = "untagged"; Tags = $tags }
    }
    if ("$liveRunId" -ne $runId) {
        return [pscustomobject]@{ State = "foreign"; Tags = $tags }
    }
    return [pscustomobject]@{ State = "owned"; Tags = $tags }
}

function Get-GroupLiveTags {
    $result = Invoke-AzCapture -Arguments @("group", "show", "--name", $rgName, "--query", "tags", "-o", "json")
    if ($result.ExitCode -eq 3) {
        return [pscustomobject]@{ State = "not-found"; Tags = $null }
    }
    if ($result.ExitCode -ne 0) {
        return [pscustomobject]@{ State = "query-failed"; Tags = $null }
    }
    if (-not $result.Output -or $result.Output -eq "null") {
        return [pscustomobject]@{ State = "untagged"; Tags = $null }
    }
    try {
        $tags = $result.Output | ConvertFrom-Json
    }
    catch {
        return [pscustomobject]@{ State = "query-failed"; Tags = $null }
    }
    if ($null -eq $tags) {
        return [pscustomobject]@{ State = "untagged"; Tags = $tags }
    }
    $liveRunId = Get-TagValue $tags "runId"
    if (-not $liveRunId) {
        return [pscustomobject]@{ State = "untagged"; Tags = $tags }
    }
    if ("$liveRunId" -ne $runId) {
        return [pscustomobject]@{ State = "foreign"; Tags = $tags }
    }
    return [pscustomobject]@{ State = "owned"; Tags = $tags }
}

function Get-DeleteArguments {
    param([string]$Type, [string]$Name)
    switch ($Type) {
        "containerapp.job" {
            return @("containerapp", "job", "delete", "--name", $Name, "--resource-group", $rgName, "--yes", "--output", "none")
        }
        "containerapp" {
            return @("containerapp", "delete", "--name", $Name, "--resource-group", $rgName, "--yes", "--output", "none")
        }
        "containerapp.env" {
            return @("containerapp", "env", "delete", "--name", $Name, "--resource-group", $rgName, "--yes", "--output", "none")
        }
        "redis" {
            return @("redis", "delete", "--name", $Name, "--resource-group", $rgName, "--yes", "--output", "none")
        }
        "postgres" {
            return @("postgres", "flexible-server", "delete", "--name", $Name, "--resource-group", $rgName, "--yes", "--output", "none")
        }
        "acr" {
            return @("acr", "delete", "--name", $Name, "--resource-group", $rgName, "--yes", "--output", "none")
        }
        "storage" {
            return @("storage", "account", "delete", "--name", $Name, "--resource-group", $rgName, "--yes", "--output", "none")
        }
        default {
            return $null
        }
    }
}

function Add-Pending {
    param([string]$Reason, [string]$Type, [string]$Name, [string]$Id)
    $script:Pending.Add([ordered]@{ reason = $Reason; type = $Type; name = $Name; id = $Id })
}

function Add-Residual {
    param([string]$Reason, [string]$Type, [string]$Name, [string]$Id)
    $duplicate = $script:Residuals | Where-Object {
        $_.reason -eq $Reason -and $_.type -eq $Type -and $_.name -eq $Name
    }
    if ($duplicate) { return }
    $script:Residuals.Add([ordered]@{ reason = $Reason; type = $Type; name = $Name; id = $Id })
}

function Save-ManifestCleanup {
    $checkedAt = (Get-Date).ToUniversalTime().ToString("o")
    $status = "completed"
    if ($script:Pending.Count -gt 0 -or $script:Residuals.Count -gt 0) {
        $status = "pending"
    }
    $message = "all run resources verified absent"
    if ($status -ne "completed") {
        $message = "ownership or residual issues detected"
    }
    $residualList = $script:Residuals.ToArray()
    $pendingList = $script:Pending.ToArray()
    $cleanup = [ordered]@{
        status    = $status
        checkedAt = $checkedAt
        residuals = $residualList
        pending   = $pendingList
        message   = $message
    }
    $manifest | Add-Member -NotePropertyName cleanup -NotePropertyValue ([pscustomobject]$cleanup) -Force
    $json = $manifest | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($ManifestPath, $json, [System.Text.UTF8Encoding]::new($false))
}

function Wait-GroupAbsent {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $present = Get-AzValue @("group", "exists", "--name", $rgName) -Operation "group exists"
        if ($present -ne "true") {
            return $true
        }
        Start-Sleep -Seconds $PollIntervalSeconds
    }
    return $false
}

function Wait-ResourceAbsent {
    param([string]$Type, [string]$Name)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $exists = $false
        switch ($Type) {
            "containerapp.job" {
                $exists = Test-AzExists @("containerapp", "job", "show", "--name", $Name, "--resource-group", $rgName)
            }
            "containerapp" {
                $exists = Test-AzExists @("containerapp", "show", "--name", $Name, "--resource-group", $rgName)
            }
            "containerapp.env" {
                $exists = Test-AzExists @("containerapp", "env", "show", "--name", $Name, "--resource-group", $rgName)
            }
            "redis" {
                $exists = Test-AzExists @("redis", "show", "--name", $Name, "--resource-group", $rgName)
            }
            "postgres" {
                $exists = Test-AzExists @("postgres", "flexible-server", "show", "--name", $Name, "--resource-group", $rgName)
            }
            "acr" {
                $exists = Test-AzExists @("acr", "show", "--name", $Name, "--resource-group", $rgName)
            }
            "storage" {
                $exists = Test-AzExists @("storage", "account", "show", "--name", $Name, "--resource-group", $rgName)
            }
            default {
                $exists = $false
            }
        }
        if (-not $exists) { return $true }
        Start-Sleep -Seconds $PollIntervalSeconds
    }
    return $false
}

function Get-TaggedResources {
    param([string[]]$ExtraArguments)
    $arguments = @("resource", "list", "--tag", "runId=$runId", "-o", "json")
    if ($ExtraArguments -and $ExtraArguments.Count -gt 0) {
        $arguments += $ExtraArguments
    }
    $result = Invoke-AzCapture -Arguments $arguments
    if ($result.ExitCode -ne 0 -or -not $result.Output) { return @() }
    try {
        $parsed = $result.Output | ConvertFrom-Json
    }
    catch {
        return @()
    }
    if ($null -eq $parsed) { return @() }
    return @($parsed)
}

function Review-Residuals {
    $tagged = Get-TaggedResources
    foreach ($item in $tagged) {
        Add-Residual "tagged-resource" "resource" "$($item.name)" "$($item.id)"
    }
    $ips = Get-TaggedResources -ExtraArguments @("--resource-type", "Microsoft.Network/publicIPAddresses")
    foreach ($item in $ips) {
        Add-Residual "public-ip" "public-ip" "$($item.name)" "$($item.id)"
    }

    if ($manifest.resources) {
        foreach ($resource in @($manifest.resources)) {
            $type = "$($resource.type)"
            $name = "$($resource.name)"
            switch ($type) {
                "storage" {
                    if (Test-AzExists @("storage", "account", "show", "--name", $name, "--resource-group", $rgName)) {
                        Add-Residual "storage-account-still-present" "storage" $name "$($resource.id)"
                        $containers = Invoke-AzCapture -Arguments @(
                            "storage", "container", "list",
                            "--account-name", $name,
                            "--include-deleted",
                            "--auth-mode", "login",
                            "-o", "json"
                        )
                        if ($containers.ExitCode -eq 0 -and $containers.Output -and $containers.Output -ne "[]") {
                            Add-Residual "blobs-or-soft-deleted-containers" "storage" $name "$($resource.id)"
                        }
                    }
                }
                "acr" {
                    if (Test-AzExists @("acr", "show", "--name", $name, "--resource-group", $rgName)) {
                        Add-Residual "registry-still-present" "acr" $name "$($resource.id)"
                        $repos = Invoke-AzCapture -Arguments @("acr", "repository", "list", "--name", $name, "-o", "json")
                        if ($repos.ExitCode -eq 0 -and $repos.Output -and $repos.Output -ne "[]") {
                            Add-Residual "registry-images" "acr" $name "$($resource.id)"
                        }
                    }
                }
                "postgres" {
                    if (Test-AzExists @("postgres", "flexible-server", "show", "--name", $name, "--resource-group", $rgName)) {
                        Add-Residual "postgres-server" "postgres" $name "$($resource.id)"
                    }
                }
                "containerapp" {
                    if (Test-AzExists @("containerapp", "show", "--name", $name, "--resource-group", $rgName)) {
                        Add-Residual "container-app" "containerapp" $name "$($resource.id)"
                    }
                }
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Teardown
# ---------------------------------------------------------------------------
Write-Info "Teardown del run '$runId' (RG '$rgName', createdByRun=$createdByRun)."

$groupTags = Get-GroupLiveTags
$groupOwned = ($groupTags.State -eq "owned")
$groupDeleteIssued = $false

if ($groupTags.State -eq "not-found") {
    Write-Info "El resource group ya no existe."
}
elseif ($createdByRun -and $groupOwned) {
    Write-Info "RG creado por el run y tags coinciden; az group delete --no-wait."
    $deleteResult = Invoke-AzCapture -Arguments @("group", "delete", "--name", $rgName, "--no-wait", "--yes", "--output", "none")
    if ($deleteResult.ExitCode -ne 0) {
        Add-Pending "group-delete-failed" "resource-group" $rgName "$($manifest.resourceGroup.id)"
    }
    else {
        $groupDeleteIssued = $true
    }
}
elseif (-not $groupOwned) {
    Add-Pending "group-not-owned" "resource-group" $rgName "$($manifest.resourceGroup.id)"
    Write-Warn "RG sin tag del run; no se borra el grupo (recurso por recurso)."
}
else {
    Write-Info "RG no fue creado por el run; se borra recurso por recurso."
}

if (-not $groupDeleteIssued) {
    $resources = @($manifest.resources)
    [array]::Reverse($resources)
    foreach ($resource in $resources) {
        $type = "$($resource.type)"
        $name = "$($resource.name)"
        $id = "$($resource.id)"
        if (-not $id) {
            Add-Pending "missing-id" $type $name ""
            continue
        }
        $live = Get-LiveTags $id
        switch ($live.State) {
            "not-found" {
                Write-Info "$type '$name' ya no existe."
            }
            "owned" {
                $arguments = Get-DeleteArguments -Type $type -Name $name
                if ($null -eq $arguments) {
                    Add-Pending "unsupported-type" $type $name $id
                    continue
                }
                $result = Invoke-AzCapture -Arguments $arguments
                if ($result.ExitCode -eq 0 -or $result.ExitCode -eq 3) {
                    $script:Deleted.Add([ordered]@{ type = $type; name = $name; id = $id })
                    Write-Info "Eliminado $type '$name'."
                }
                else {
                    Add-Pending "delete-failed" $type $name $id
                }
            }
            "untagged" {
                Add-Pending "untagged" $type $name $id
                Write-Warn "$type '$name' sin tag runId; no se borra."
            }
            "foreign" {
                Add-Pending "foreign-run" $type $name $id
                Write-Warn "$type '$name' pertenece a otro run; no se borra."
            }
            default {
                Add-Pending "ownership-query-failed" $type $name $id
            }
        }
    }

    foreach ($resource in $script:Deleted) {
        if (-not (Wait-ResourceAbsent -Type $resource.type -Name $resource.name)) {
            Add-Residual "still-present" $resource.type $resource.name $resource.id
        }
    }
}

if ($groupDeleteIssued) {
    if (-not (Wait-GroupAbsent)) {
        Add-Residual "group-still-present" "resource-group" $rgName "$($manifest.resourceGroup.id)"
    }
}

Review-Residuals

$script:Pending | ForEach-Object {
    Write-Warn ("pending: {0} {1} '{2}'" -f $_.reason, $_.type, $_.name)
}
$script:Residuals | ForEach-Object {
    Write-Warn ("residual: {0} {1} '{2}'" -f $_.reason, $_.type, $_.name)
}

Save-ManifestCleanup

if ($script:Pending.Count -gt 0 -or $script:Residuals.Count -gt 0) {
    Write-Warn ("Cleanup PENDING: {0} pending, {1} residual." -f $script:Pending.Count, $script:Residuals.Count)
    exit 1
}

Write-Info "Cleanup verificado: no quedan recursos del run."
exit 0
