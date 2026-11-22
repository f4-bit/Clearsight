#Requires -Version 5.1
<#
.SYNOPSIS
    Real Azure E2E driver for the Clearsight clinical pipeline.

.DESCRIPTION
    Drives a deployed backend (Container App) over HTTPS through the full
    clinical pipeline against real Azure Blob Storage, PostgreSQL, the worker
    and the ML service:

      1. Negative-auth check (GET /inferences/<uuid> without Bearer -> 401).
      2. Admin login and controlled ophthalmologist provisioning.
      3. Doctor login.
      4. Pseudonymized patient and consultation.
      5. Multipart image upload (sanitizer -> Blob).
      6. Inference request with a durable Idempotency-Key.
      7. Bounded polling (honouring Retry-After) until a terminal status.
      8. Artifact/report catalog, signed URLs and content validation.
      9. Clinical feedback and optional gold-standard export.

    The script never provisions or deletes Azure resources. Teardown is a
    separate step (`scripts/teardown_azure.ps1`) invoked by the orchestrator.

    Secrets (passwords, access tokens and signed URLs) are kept in memory,
    redacted from every message and never written to disk. The only file this
    script writes is a non-secret `summary.json` inside `-OutDir`.

.PARAMETER BackendBaseUrl
    HTTPS FQDN of the deployed backend Container App (for example
    `https://clearsight-run123-backend.example.azurecontainerapps.io`).
    Loopback HTTP is accepted only for the offline stub tests.

.PARAMETER AdminEmail
    Email of the administrator used to create the test ophthalmologist.

.PARAMETER AdminPassword
    Administrator password (SecureString, >=12 Unicode code points).

.PARAMETER DoctorEmail
    Email of the test ophthalmologist created by the administrator.

.PARAMETER DoctorPassword
    Doctor password (SecureString, >=12 Unicode code points).

.PARAMETER OutDir
    Temporary output directory for `summary.json`. Defaults to a unique temp
    directory when omitted.

.PARAMETER ImagePath
    Optional JPEG/PNG retinal image. When omitted a 640x640 synthetic JPEG is
    generated in memory.

.PARAMETER AuthOrigin
    Optional Origin header used on credential endpoints. Defaults to the
    BackendBaseUrl origin. It must match the backend `AUTH_PUBLIC_ORIGIN`.

.PARAMETER TimeoutSeconds
    Overall polling deadline for the inference and artifact delivery (default
    900 seconds).

.PARAMETER PollIntervalSeconds
    Fallback poll interval when the backend does not send Retry-After (default
    2 seconds).

.PARAMETER RequestTimeoutSeconds
    Per-request timeout for JSON/API calls (default 60 seconds).

.EXAMPLE
    pwsh ./scripts/e2e_azure_pipeline.ps1 `
        -BackendBaseUrl https://clearsight-run123-backend.example.azurecontainerapps.io `
        -AuthOrigin https://clearsight-run123-frontend.example.azurecontainerapps.io `
        -AdminEmail admin@example.test `
        -AdminPassword (Read-Host -AsSecureString) `
        -DoctorEmail doctor@example.test `
        -DoctorPassword (Read-Host -AsSecureString) `
        -OutDir $env:TEMP\clearsight-azure-e2e
#>
[CmdletBinding()]
param(
    [string]$BackendBaseUrl = "",
    [string]$AdminEmail = "",
    [securestring]$AdminPassword,
    [string]$DoctorEmail = "",
    [securestring]$DoctorPassword,
    [string]$OutDir = "",
    [string]$ImagePath = "",
    [string]$AuthOrigin = "",
    [int]$TimeoutSeconds = 900,
    [int]$PollIntervalSeconds = 2,
    [int]$RequestTimeoutSeconds = 60
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$script:ExitInput = 1
$script:ExitAuth = 2
$script:ExitFlow = 3
$script:ExitVerify = 4

$script:SecretValues = New-Object System.Collections.Generic.List[string]
$script:Steps = @()
$script:Ids = [ordered]@{}
$script:Checks = [ordered]@{}
$script:ArtifactSummary = [ordered]@{}
$script:Error = $null
$script:ExitCode = 0
$script:StartedAt = (Get-Date).ToUniversalTime().ToString("o")
$script:BaseUrl = ""
$script:BaseScheme = ""
$script:AuthOrigin = ""
$script:SummaryPath = ""
$script:CurrentStep = "init"
$script:InferenceDeadline = (Get-Date)
$script:ImageBytes = $null

$script:ClinicalFeatures = [ordered]@{
    Age                  = 63
    Gender               = 1
    dioptre_1            = -1.5
    dioptre_2            = 0.5
    astigmatism          = 90
    "Phakic/Pseudophakic" = 1
    Pneumatic            = 18
    Perkins              = 17
    Pachymetry           = 540
    Axial_Length         = 24.1
    VF_DM                = -3.2
}

function Protect-Message([string]$Message) {
    if ($null -eq $Message) { return "" }
    $result = $Message
    foreach ($secret in $script:SecretValues) {
        if ($secret -and $secret.Length -ge 4) {
            $result = $result.Replace($secret, "***")
        }
    }
    return $result
}

function Register-Secret([string]$Value) {
    if ($Value -and $Value.Length -ge 4 -and -not $script:SecretValues.Contains($Value)) {
        $script:SecretValues.Add($Value)
    }
    return $Value
}

function Add-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Status,
        [string]$Detail = ""
    )
    $safeDetail = Protect-Message $Detail
    $script:Steps += [pscustomobject]([ordered]@{
        name   = $Name
        status = $Status
        detail = $safeDetail
    })
    $color = "Green"
    if ($Status -ne "PASSED") { $color = "Red" }
    if ($Status -eq "SKIPPED") { $color = "Yellow" }
    Write-Host ("[clearsight] {0}: {1} ({2})" -f $Name, $Status, $safeDetail) -ForegroundColor $color
}

function Fail-Step {
    param(
        [Parameter(Mandatory = $true)][string]$StepName,
        [Parameter(Mandatory = $true)][string]$Message,
        [int]$Code = 3
    )
    $script:CurrentStep = $StepName
    $safe = Protect-Message $Message
    Add-Step -Name $StepName -Status "FAILED" -Detail $safe
    $script:Error = [ordered]@{
        step    = $StepName
        code    = $Code
        message = $safe
    }
    $script:ExitCode = $Code
    throw [System.Exception]::new("__CLEARSIGHT_E2E_STEP_FAILED__")
}

function ConvertTo-PlainText([securestring]$Secure) {
    if ($null -eq $Secure) { return "" }
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Get-CodePointCount([string]$Value) {
    if ($null -eq $Value) { return 0 }
    $count = 0
    for ($index = 0; $index -lt $Value.Length; $index++) {
        if ([char]::IsHighSurrogate($Value[$index]) -and
            ($index + 1) -lt $Value.Length -and
            [char]::IsLowSurrogate($Value[$index + 1])) {
            $index++
        }
        $count++
    }
    return $count
}

function Assert-Password([string]$Value, [string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        Fail-Step "config" ("{0} is empty" -f $Name) $script:ExitInput
    }
    if ((Get-CodePointCount $Value) -lt 12) {
        Fail-Step "config" ("{0} must contain at least 12 Unicode code points" -f $Name) $script:ExitInput
    }
    if ([System.Text.Encoding]::UTF8.GetByteCount($Value) -gt 72) {
        Fail-Step "config" ("{0} must be at most 72 UTF-8 bytes" -f $Name) $script:ExitInput
    }
}

function Assert-Email([string]$Value, [string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        Fail-Step "config" ("{0} is empty" -f $Name) $script:ExitInput
    }
    $trimmed = $Value.Trim().ToLowerInvariant()
    if ($trimmed.Length -gt 255 -or $trimmed -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
        Fail-Step "config" ("{0} is not a valid email" -f $Name) $script:ExitInput
    }
    return $trimmed
}

function Assert-Origin([string]$Value, [string]$Name) {
    $parsed = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$parsed)) {
        Fail-Step "config" ("{0} is not an absolute origin" -f $Name) $script:ExitInput
    }
    if ($parsed.Scheme -ne "http" -and $parsed.Scheme -ne "https") {
        Fail-Step "config" ("{0} must use http or https" -f $Name) $script:ExitInput
    }
    if ($parsed.AbsolutePath -ne "/" -and $parsed.AbsolutePath -ne "") {
        Fail-Step "config" ("{0} must not include a path" -f $Name) $script:ExitInput
    }
    if ($parsed.Query -or $parsed.Fragment -or $parsed.UserInfo) {
        Fail-Step "config" ("{0} must not include credentials, query or fragment" -f $Name) $script:ExitInput
    }
    return $parsed.GetLeftPart([UriPartial]::Authority)
}

function Get-HttpStatus($ErrorRecord) {
    try {
        $response = $ErrorRecord.Exception.Response
        if ($null -eq $response) { return 0 }
        $statusCode = $response.StatusCode
        if ($null -eq $statusCode) { return 0 }
        if ($statusCode -is [System.Enum]) { return [int]$statusCode }
        return [int]$statusCode
    }
    catch {
        return 0
    }
}

function Get-HeaderValue($Headers, [string]$Name) {
    if ($null -eq $Headers) { return $null }
    try {
        $value = $Headers[$Name]
        if ($null -eq $value) { return $null }
        if ($value -is [array]) {
            if ($value.Length -eq 0) { return $null }
            return [string]$value[0]
        }
        return [string]$value
    }
    catch {
        return $null
    }
}

function Invoke-Api {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [hashtable]$Headers = @{},
        [string]$JsonBody = $null,
        [byte[]]$RawBody = $null,
        [string]$ContentType = $null
    )
    $uri = "$script:BaseUrl$Path"
    $params = @{
        Method          = $Method
        Uri             = $uri
        UseBasicParsing = $true
        TimeoutSec      = $script:RequestTimeoutSeconds
        ErrorAction     = "Stop"
    }
    if ($Headers.Count -gt 0) { $params.Headers = $Headers }

    # A typed [byte[]] parameter defaults to an empty array, so Hashtable
    # splatting with `$null -ne $RawBody` would incorrectly add a body to GET.
    # Bind the body only when the caller actually supplied that parameter.
    $hasRawBody = $PSBoundParameters.ContainsKey("RawBody") -and $null -ne $RawBody
    $hasJsonBody = $PSBoundParameters.ContainsKey("JsonBody") -and $null -ne $JsonBody
    if ($hasRawBody) {
        $params.Body = $RawBody
        $params.ContentType = $ContentType
    }
    elseif ($hasJsonBody) {
        $params.Body = $JsonBody
        $params.ContentType = "application/json"
    }
    try {
        $response = Invoke-WebRequest @params
        return [pscustomobject]@{
            Status  = [int]$response.StatusCode
            Content = [string]$response.Content
            Headers = $response.Headers
        }
    }
    catch {
        return [pscustomobject]@{
            Status  = Get-HttpStatus $_
            Content = $null
            Headers = $null
        }
    }
}

function Assert-HttpStatus {
    param(
        $Response,
        [int[]]$Expected,
        [string]$StepName
    )
    if ($Expected -notcontains $Response.Status) {
        Fail-Step $StepName ("unexpected HTTP status {0}" -f $Response.Status) $script:ExitFlow
    }
}

function ConvertFrom-ApiJson {
    param($Response, [string]$StepName)
    if ([string]::IsNullOrWhiteSpace($Response.Content)) {
        Fail-Step $StepName ("empty response body (HTTP {0})" -f $Response.Status) $script:ExitFlow
    }
    try {
        return $Response.Content | ConvertFrom-Json
    }
    catch {
        Fail-Step $StepName ("invalid JSON response (HTTP {0})" -f $Response.Status) $script:ExitFlow
    }
}

function New-AuthHeaders([string]$Token, [hashtable]$Extra = @{}) {
    $headers = @{ Authorization = "Bearer $Token" }
    foreach ($key in $Extra.Keys) { $headers[$key] = $Extra[$key] }
    return $headers
}

function Invoke-Login {
    param(
        [string]$Email,
        [string]$Password,
        [string]$StepName
    )
    $payload = [ordered]@{
        email    = $Email
        password = $Password
    } | ConvertTo-Json -Compress
    $response = Invoke-Api -Method "POST" -Path "/auth/login" -Headers @{ Origin = $script:AuthOrigin } -JsonBody $payload
    Assert-HttpStatus $response @(200) $StepName
    $body = ConvertFrom-ApiJson $response $StepName
    $token = [string]$body.accessToken
    if ([string]::IsNullOrWhiteSpace($token)) {
        Fail-Step $StepName "login response is missing accessToken" $script:ExitFlow
    }
    Register-Secret $token | Out-Null
    return [pscustomobject]@{
        Token = $token
        User  = $body.user
    }
}

function Get-SyntheticImageBytes {
    try {
        Add-Type -AssemblyName System.Drawing
        $size = 640
        $bitmap = New-Object System.Drawing.Bitmap -ArgumentList $size, $size
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.Clear([System.Drawing.Color]::FromArgb(42, 30, 24))
                $fundus = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(190, 150, 120))
                try {
                    $graphics.FillEllipse($fundus, 40, 40, 560, 560)
                }
                finally {
                    $fundus.Dispose()
                }
                $disc = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(225, 215, 190))
                try {
                    $graphics.FillEllipse($disc, 380, 280, 90, 90)
                }
                finally {
                    $disc.Dispose()
                }
            }
            finally {
                $graphics.Dispose()
            }
            $stream = New-Object System.IO.MemoryStream
            try {
                $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Jpeg)
                return ,$stream.ToArray()
            }
            finally {
                $stream.Dispose()
            }
        }
        finally {
            $bitmap.Dispose()
        }
    }
    catch {
        Fail-Step "image" "could not generate a synthetic JPEG; pass -ImagePath" $script:ExitInput
    }
}

function Get-ImageBytes {
    if (-not [string]::IsNullOrWhiteSpace($ImagePath)) {
        if (-not (Test-Path -LiteralPath $ImagePath -PathType Leaf)) {
            Fail-Step "image" "ImagePath does not exist" $script:ExitInput
        }
        $bytes = [System.IO.File]::ReadAllBytes($ImagePath)
        if ($bytes.Length -eq 0) {
            Fail-Step "image" "ImagePath is empty" $script:ExitInput
        }
        return ,$bytes
    }
    $generated = Get-SyntheticImageBytes
    return ,$generated
}

function New-MultipartBody {
    param(
        [string]$EyeSide,
        [byte[]]$FileBytes,
        [string]$FileName = "retina.jpg"
    )
    $boundary = "----clearsight-e2e-" + [guid]::NewGuid().ToString("N")
    $encoding = [System.Text.Encoding]::UTF8
    $stream = New-Object System.IO.MemoryStream
    try {
        $head = "--$boundary`r`nContent-Disposition: form-data; name=`"eyeSide`"`r`n`r`n$EyeSide`r`n" +
                "--$boundary`r`nContent-Disposition: form-data; name=`"file`"; filename=`"$FileName`"`r`nContent-Type: image/jpeg`r`n`r`n"
        $headBytes = $encoding.GetBytes($head)
        $stream.Write($headBytes, 0, $headBytes.Length)
        $stream.Write($FileBytes, 0, $FileBytes.Length)
        $tailBytes = $encoding.GetBytes("`r`n--$boundary--`r`n")
        $stream.Write($tailBytes, 0, $tailBytes.Length)
        return [pscustomobject]@{
            Bytes       = $stream.ToArray()
            ContentType = "multipart/form-data; boundary=$boundary"
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Get-PollDelay($Response) {
    $delay = $PollIntervalSeconds
    $retryAfter = Get-HeaderValue $Response.Headers "Retry-After"
    if ($retryAfter -match '^\d+$') {
        $delay = [int]$retryAfter
    }
    if ($delay -lt 0) { $delay = 0 }
    if ($delay -gt 30) { $delay = 30 }
    return $delay
}

function Wait-InferenceTerminal {
    param(
        [string]$InferenceId,
        [string]$Token
    )
    $terminal = @("COMPLETED", "REVIEW_REQUIRED", "FAILED")
    $last = $null
    while ((Get-Date) -lt $script:InferenceDeadline) {
        $response = Invoke-Api -Method "GET" -Path "/inferences/$InferenceId" -Headers (New-AuthHeaders $Token)
        if ($response.Status -eq 401) {
            Fail-Step "poll-inference" "session rejected (HTTP 401)" $script:ExitAuth
        }
        if ($response.Status -ne 200) {
            Fail-Step "poll-inference" ("GET inference returned HTTP {0}" -f $response.Status) $script:ExitFlow
        }
        $last = ConvertFrom-ApiJson $response "poll-inference"
        $status = [string]$last.status
        if ($terminal -contains $status) {
            return $last
        }
        $delay = Get-PollDelay $response
        $remaining = [int][Math]::Floor(($script:InferenceDeadline - (Get-Date)).TotalSeconds)
        if ($remaining -le 0) { break }
        if ($delay -gt $remaining) { $delay = $remaining }
        if ($delay -gt 0) { Start-Sleep -Seconds $delay }
    }
    $lastStatus = "unknown"
    if ($null -ne $last) { $lastStatus = [string]$last.status }
    Fail-Step "poll-inference" ("inference did not reach a terminal status before the timeout (last status: {0})" -f $lastStatus) $script:ExitVerify
}

function Get-ArtifactCatalog {
    param(
        [string]$InferenceId,
        [string]$Token
    )
    while ((Get-Date) -lt $script:InferenceDeadline) {
        $response = Invoke-Api -Method "GET" -Path "/inferences/$InferenceId/artifacts" -Headers (New-AuthHeaders $Token)
        if ($response.Status -eq 503) {
            Fail-Step "artifacts" "artifact store is unavailable (HTTP 503)" $script:ExitVerify
        }
        Assert-HttpStatus $response @(200) "artifacts"
        $body = ConvertFrom-ApiJson $response "artifacts"

        $versions = @{}
        $statuses = @{}
        foreach ($item in @($body.items)) {
            $type = [string]$item.reference.artifactType
            if ([string]::IsNullOrWhiteSpace($type)) { continue }
            $statuses[$type] = [string]$item.reference.status
            $versions[$type] = [int]$item.version
        }

        $pending = @()
        foreach ($required in @("mask", "overlay")) {
            if (-not $statuses.ContainsKey($required)) {
                # Publication may still be within its reconcile window after
                # the terminal status; retry instead of reporting a false miss.
                $pending += $required
                continue
            }
            $status = $statuses[$required]
            if ($status -eq "AVAILABLE") { continue }
            if ($status -eq "PENDING") {
                $pending += $required
                continue
            }
            Fail-Step "artifacts" ("{0} artifact is {1}, expected AVAILABLE" -f $required, $status) $script:ExitVerify
        }

        if ($pending.Count -eq 0) {
            return [pscustomobject]@{
                Statuses = $statuses
                Versions = $versions
            }
        }

        $remaining = [int][Math]::Floor(($script:InferenceDeadline - (Get-Date)).TotalSeconds)
        if ($remaining -le 0) { break }
        $delay = $PollIntervalSeconds
        if ($delay -gt $remaining) { $delay = $remaining }
        if ($delay -gt 0) { Start-Sleep -Seconds $delay }
    }
    Fail-Step "artifacts" "mask/overlay artifacts did not become AVAILABLE before the timeout" $script:ExitVerify
}

function Get-AvailableReport {
    param(
        [string]$InferenceId,
        [string]$Token
    )
    while ((Get-Date) -lt $script:InferenceDeadline) {
        $response = Invoke-Api -Method "GET" -Path "/inferences/$InferenceId/reports" -Headers (New-AuthHeaders $Token)
        if ($response.Status -eq 503) {
            Fail-Step "reports" "report store is unavailable (HTTP 503)" $script:ExitVerify
        }
        Assert-HttpStatus $response @(200) "reports"
        $body = @(ConvertFrom-ApiJson $response "reports")

        $available = @($body | Where-Object { [string]$_.status -eq "AVAILABLE" })
        if ($available.Count -gt 0) {
            return ($available | Sort-Object version -Descending | Select-Object -First 1)
        }

        $failed = @($body | Where-Object { [string]$_.status -eq "FAILED" })
        if ($failed.Count -gt 0) {
            Fail-Step "reports" "PDF report generation failed; no AVAILABLE PDF report" $script:ExitVerify
        }

        $remaining = [int][Math]::Floor(($script:InferenceDeadline - (Get-Date)).TotalSeconds)
        if ($remaining -le 0) { break }
        $delay = $PollIntervalSeconds
        if ($delay -gt $remaining) { $delay = $remaining }
        if ($delay -gt 0) { Start-Sleep -Seconds $delay }
    }
    Fail-Step "reports" "PDF report did not become AVAILABLE before the timeout" $script:ExitVerify
}

function Get-SignedArtifactUrl {
    param(
        [string]$Path,
        [string]$Token,
        [string]$StepName
    )
    $response = Invoke-Api -Method "GET" -Path $Path -Headers (New-AuthHeaders $Token)
    if ($response.Status -eq 409) {
        Fail-Step $StepName "artifact object is unavailable in the store (HTTP 409)" $script:ExitVerify
    }
    if ($response.Status -eq 503) {
        Fail-Step $StepName "artifact store is unavailable (HTTP 503)" $script:ExitVerify
    }
    Assert-HttpStatus $response @(200) $StepName
    $body = ConvertFrom-ApiJson $response $StepName

    $status = [string]$body.status
    if ($status -ne "AVAILABLE") {
        Fail-Step $StepName ("artifact status is {0}, expected AVAILABLE" -f $status) $script:ExitVerify
    }

    $url = [string]$body.url
    if ([string]::IsNullOrWhiteSpace($url)) {
        Fail-Step $StepName "signed URL is missing" $script:ExitVerify
    }
    Register-Secret $url | Out-Null

    $expires = 0
    try { $expires = [int]$body.expiresInSeconds } catch { $expires = 0 }
    if ($expires -le 0 -or $expires -gt 3600) {
        Fail-Step $StepName "expiresInSeconds is missing or out of range" $script:ExitVerify
    }

    $parsed = $null
    if (-not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$parsed)) {
        Fail-Step $StepName "signed URL is not absolute" $script:ExitVerify
    }
    if ($parsed.Scheme -ne "https" -and $parsed.Scheme -ne "http") {
        Fail-Step $StepName "signed URL scheme is not http(s)" $script:ExitVerify
    }
    if ($script:BaseScheme -eq "https" -and $parsed.Scheme -ne "https") {
        Fail-Step $StepName "signed URL must use HTTPS" $script:ExitVerify
    }

    return [pscustomobject]@{
        Url             = $url
        ExpiresInSeconds = $expires
        ContentType     = [string]$body.contentType
        ReportVersion   = $body.reportVersion
    }
}

function Get-DownloadBytes {
    param(
        [string]$Url,
        [string]$StepName
    )
    try {
        $client = New-Object System.Net.WebClient
        try {
            return ,$client.DownloadData($Url)
        }
        finally {
            $client.Dispose()
        }
    }
    catch {
        Fail-Step $StepName "signed URL download failed" $script:ExitVerify
    }
}

function Assert-PngMagic {
    param([byte[]]$Bytes, [string]$StepName)
    $magic = @(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
    if ($null -eq $Bytes -or $Bytes.Length -lt $magic.Length) {
        Fail-Step $StepName "downloaded PNG is empty or truncated" $script:ExitVerify
    }
    for ($index = 0; $index -lt $magic.Length; $index++) {
        if ($Bytes[$index] -ne $magic[$index]) {
            Fail-Step $StepName "downloaded content is not a PNG" $script:ExitVerify
        }
    }
}

function Assert-PdfMagic {
    param([byte[]]$Bytes, [string]$StepName)
    if ($null -eq $Bytes -or $Bytes.Length -lt 5) {
        Fail-Step $StepName "downloaded PDF is empty or truncated" $script:ExitVerify
    }
    $prefix = [System.Text.Encoding]::ASCII.GetString($Bytes, 0, 5)
    if ($prefix -ne "%PDF-") {
        Fail-Step $StepName "downloaded content is not a PDF" $script:ExitVerify
    }
}

function Save-Summary {
    if ([string]::IsNullOrWhiteSpace($script:SummaryPath)) { return }
    $result = "FAILED"
    if ($script:ExitCode -eq 0) { $result = "PASSED" }
    $summary = [ordered]@{
        schemaVersion   = 1
        result          = $result
        exitCode        = $script:ExitCode
        startedAt       = $script:StartedAt
        finishedAt      = (Get-Date).ToUniversalTime().ToString("o")
        backendBaseUrl  = $script:BaseUrl
        authOrigin      = $script:AuthOrigin
        steps           = @($script:Steps)
        ids             = $script:Ids
        checks          = $script:Checks
        artifacts       = $script:ArtifactSummary
        error           = $script:Error
    }
    $json = $summary | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText(
        $script:SummaryPath,
        $json,
        (New-Object System.Text.UTF8Encoding($false))
    )
}

# ---------------------------------------------------------------------------
# Configuration validation happens before any HTTP request.
# ---------------------------------------------------------------------------
try {
    if ([string]::IsNullOrWhiteSpace($OutDir)) {
        $OutDir = Join-Path ([System.IO.Path]::GetTempPath()) ("clearsight-azure-e2e-" + [guid]::NewGuid().ToString("N"))
    }
    if (-not (Test-Path -LiteralPath $OutDir)) {
        New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath $OutDir -PathType Container)) {
        Fail-Step "config" "OutDir is not a directory" $script:ExitInput
    }
    $script:SummaryPath = Join-Path $OutDir "summary.json"

    if ([string]::IsNullOrWhiteSpace($BackendBaseUrl)) {
        Fail-Step "config" "BackendBaseUrl is required" $script:ExitInput
    }
    $baseUri = $null
    if (-not [Uri]::TryCreate($BackendBaseUrl.Trim(), [UriKind]::Absolute, [ref]$baseUri)) {
        Fail-Step "config" "BackendBaseUrl is not an absolute URL" $script:ExitInput
    }
    if ($baseUri.Scheme -ne "https" -and $baseUri.Scheme -ne "http") {
        Fail-Step "config" "BackendBaseUrl must use https" $script:ExitInput
    }
    if ($baseUri.Scheme -eq "http" -and -not ($baseUri.IsLoopback -or $baseUri.Host -eq "localhost")) {
        Fail-Step "config" "BackendBaseUrl must use HTTPS outside loopback" $script:ExitInput
    }
    if ($baseUri.Scheme -eq "https" -and $baseUri.Host -notmatch '\.') {
        Fail-Step "config" "BackendBaseUrl must be the HTTPS FQDN of the backend" $script:ExitInput
    }
    if ($baseUri.AbsolutePath -ne "/" -and $baseUri.AbsolutePath -ne "") {
        Fail-Step "config" "BackendBaseUrl must not include a path" $script:ExitInput
    }
    if ($baseUri.Query -or $baseUri.Fragment -or $baseUri.UserInfo) {
        Fail-Step "config" "BackendBaseUrl must not include credentials, query or fragment" $script:ExitInput
    }
    $script:BaseUrl = $baseUri.GetLeftPart([UriPartial]::Authority)
    $script:BaseScheme = $baseUri.Scheme

    if ([string]::IsNullOrWhiteSpace($AuthOrigin)) {
        $script:AuthOrigin = $script:BaseUrl
    }
    else {
        $script:AuthOrigin = Assert-Origin $AuthOrigin "AuthOrigin"
    }

    if ($TimeoutSeconds -le 0) {
        Fail-Step "config" "TimeoutSeconds must be positive" $script:ExitInput
    }
    if ($PollIntervalSeconds -lt 0) {
        Fail-Step "config" "PollIntervalSeconds must not be negative" $script:ExitInput
    }
    if ($RequestTimeoutSeconds -le 0) {
        Fail-Step "config" "RequestTimeoutSeconds must be positive" $script:ExitInput
    }

    $adminEmailValue = Assert-Email $AdminEmail "AdminEmail"
    $doctorEmailValue = Assert-Email $DoctorEmail "DoctorEmail"
    $adminPasswordValue = ConvertTo-PlainText $AdminPassword
    $doctorPasswordValue = ConvertTo-PlainText $DoctorPassword
    Assert-Password $adminPasswordValue "AdminPassword"
    Assert-Password $doctorPasswordValue "DoctorPassword"
    Register-Secret $adminPasswordValue | Out-Null
    Register-Secret $doctorPasswordValue | Out-Null

    # Fail fast on an invalid image before creating any clinical resource.
    $script:ImageBytes = Get-ImageBytes
}
catch {
    if ($null -eq $script:Error) {
        $script:ExitCode = $script:ExitInput
        $script:Error = [ordered]@{
            step    = $script:CurrentStep
            code    = $script:ExitCode
            message = "configuration validation failed"
        }
    }
    Save-Summary
    Write-Host ("[clearsight] BLOQUEO: {0}" -f $script:Error.message) -ForegroundColor Red
    exit $script:ExitCode
}

# ---------------------------------------------------------------------------
# Clinical flow.
# ---------------------------------------------------------------------------
try {
    $script:CurrentStep = "negative-auth"
    $missingInferenceId = [guid]::NewGuid().ToString()
    $negative = Invoke-Api -Method "GET" -Path "/inferences/$missingInferenceId"
    if ($negative.Status -ne 401) {
        Fail-Step "negative-auth" ("unauthenticated inference read returned HTTP {0}, expected 401" -f $negative.Status) $script:ExitAuth
    }
    Add-Step "negative-auth" "PASSED" "unauthenticated inference read returned 401"
    $script:Checks["negativeAuth401"] = $true

    $script:CurrentStep = "login-admin"
    $adminSession = Invoke-Login $adminEmailValue $adminPasswordValue "login-admin"
    Add-Step "login-admin" "PASSED" "administrator session established"
    $script:Checks["adminLogin"] = $true

    $script:CurrentStep = "create-doctor"
    $doctorPayload = [ordered]@{
        email    = $doctorEmailValue
        password = $doctorPasswordValue
        fullName = "E2E Azure Ophthalmologist"
        role     = "OFTALMOLOGO"
    } | ConvertTo-Json -Compress
    $createdDoctor = Invoke-Api -Method "POST" -Path "/admin/users" -Headers (New-AuthHeaders $adminSession.Token) -JsonBody $doctorPayload
    Assert-HttpStatus $createdDoctor @(201) "create-doctor"
    $doctorBody = ConvertFrom-ApiJson $createdDoctor "create-doctor"
    $script:Ids["doctorUserId"] = [string]$doctorBody.id
    Add-Step "create-doctor" "PASSED" "ophthalmologist provisioned by the administrator"
    $script:Checks["doctorCreated"] = $true

    $script:CurrentStep = "login-doctor"
    $doctorSession = Invoke-Login $doctorEmailValue $doctorPasswordValue "login-doctor"
    Add-Step "login-doctor" "PASSED" "ophthalmologist session established"
    $script:Checks["doctorLogin"] = $true

    $script:CurrentStep = "create-patient"
    $externalCode = "E2E-AZ-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss") + "-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
    $patientPayload = [ordered]@{
        externalCode = $externalCode
        age          = 63
        gender       = "M"
    } | ConvertTo-Json -Compress
    $patientResponse = Invoke-Api -Method "POST" -Path "/patients" -Headers (New-AuthHeaders $doctorSession.Token) -JsonBody $patientPayload
    Assert-HttpStatus $patientResponse @(201) "create-patient"
    $patientBody = ConvertFrom-ApiJson $patientResponse "create-patient"
    $patientId = [string]$patientBody.id
    if ([string]::IsNullOrWhiteSpace($patientId)) {
        Fail-Step "create-patient" "patient response is missing id" $script:ExitFlow
    }
    $script:Ids["patientId"] = $patientId
    Add-Step "create-patient" "PASSED" "pseudonymized patient created"

    $script:CurrentStep = "create-consultation"
    $consultationPayload = [ordered]@{
        patientId     = $patientId
        status        = "QUEUED"
        clinicalData  = $script:ClinicalFeatures
    } | ConvertTo-Json -Depth 6 -Compress
    $consultationResponse = Invoke-Api -Method "POST" -Path "/consultations" -Headers (New-AuthHeaders $doctorSession.Token) -JsonBody $consultationPayload
    Assert-HttpStatus $consultationResponse @(201) "create-consultation"
    $consultationBody = ConvertFrom-ApiJson $consultationResponse "create-consultation"
    $consultationId = [string]$consultationBody.id
    if ([string]::IsNullOrWhiteSpace($consultationId)) {
        Fail-Step "create-consultation" "consultation response is missing id" $script:ExitFlow
    }
    $script:Ids["consultationId"] = $consultationId
    Add-Step "create-consultation" "PASSED" "consultation created"

    $script:CurrentStep = "upload-image"
    $multipart = New-MultipartBody -EyeSide "OD" -FileBytes $script:ImageBytes
    $uploadResponse = Invoke-Api -Method "POST" -Path "/consultations/$consultationId/images" -Headers (New-AuthHeaders $doctorSession.Token) -RawBody $multipart.Bytes -ContentType $multipart.ContentType
    Assert-HttpStatus $uploadResponse @(201) "upload-image"
    $uploadBody = ConvertFrom-ApiJson $uploadResponse "upload-image"
    $imageId = [string]$uploadBody.id
    if ([string]::IsNullOrWhiteSpace($imageId)) {
        Fail-Step "upload-image" "image response is missing id" $script:ExitFlow
    }
    if ([string]$uploadBody.eyeSide -ne "OD") {
        Fail-Step "upload-image" "image response does not preserve eyeSide OD" $script:ExitVerify
    }
    $script:Ids["imageId"] = $imageId
    $script:Checks["imageSanitized"] = $true
    Add-Step "upload-image" "PASSED" "image uploaded and sanitized"

    $script:CurrentStep = "create-inference"
    $idempotencyKey = [guid]::NewGuid().ToString()
    $inferencePayload = [ordered]@{
        imageId          = $imageId
        eyeSide          = "OD"
        clinicalFeatures = $script:ClinicalFeatures
        modelVersion     = $null
    } | ConvertTo-Json -Depth 6 -Compress
    $inferenceHeaders = New-AuthHeaders $doctorSession.Token @{ "Idempotency-Key" = $idempotencyKey }
    $inferenceResponse = Invoke-Api -Method "POST" -Path "/inferences" -Headers $inferenceHeaders -JsonBody $inferencePayload
    Assert-HttpStatus $inferenceResponse @(202) "create-inference"
    $inferenceBody = ConvertFrom-ApiJson $inferenceResponse "create-inference"
    $inferenceId = [string]$inferenceBody.inferenceId
    if ([string]::IsNullOrWhiteSpace($inferenceId)) {
        Fail-Step "create-inference" "inference response is missing inferenceId" $script:ExitFlow
    }
    if ([string]$inferenceBody.status -ne "QUEUED") {
        Fail-Step "create-inference" ("inference accepted with unexpected status {0}" -f $inferenceBody.status) $script:ExitFlow
    }
    $jobId = [string]$inferenceBody.jobId
    if ([string]::IsNullOrWhiteSpace($jobId)) {
        Fail-Step "create-inference" "inference response is missing jobId" $script:ExitFlow
    }
    $script:Ids["inferenceId"] = $inferenceId
    $script:Ids["jobId"] = $jobId
    $script:InferenceDeadline = (Get-Date).AddSeconds($TimeoutSeconds)
    Add-Step "create-inference" "PASSED" "inference queued with Idempotency-Key"

    $script:CurrentStep = "poll-inference"
    $inference = Wait-InferenceTerminal -InferenceId $inferenceId -Token $doctorSession.Token
    $terminalStatus = [string]$inference.status
    if ($terminalStatus -eq "FAILED") {
        Fail-Step "poll-inference" "inference reached terminal status FAILED" $script:ExitVerify
    }
    if ($terminalStatus -ne "COMPLETED" -and $terminalStatus -ne "REVIEW_REQUIRED") {
        Fail-Step "poll-inference" ("unexpected terminal status {0}" -f $terminalStatus) $script:ExitVerify
    }
    $delivery = $inference.delivery
    if ($null -eq $delivery) {
        Fail-Step "poll-inference" "inference response is missing delivery state" $script:ExitVerify
    }
    $script:Checks["terminalStatus"] = $terminalStatus
    $script:Checks["deliveryTerminal"] = [bool]$delivery.deliveryTerminal
    Add-Step "poll-inference" "PASSED" ("terminal status {0} reached" -f $terminalStatus)

    $script:CurrentStep = "artifacts"
    $catalog = Get-ArtifactCatalog -InferenceId $inferenceId -Token $doctorSession.Token
    $script:ArtifactSummary["mask"] = [string]$catalog.Statuses["mask"]
    $script:ArtifactSummary["overlay"] = [string]$catalog.Statuses["overlay"]
    Add-Step "artifacts" "PASSED" "mask and overlay artifacts are AVAILABLE"

    $script:CurrentStep = "reports"
    $report = Get-AvailableReport -InferenceId $inferenceId -Token $doctorSession.Token
    $reportVersion = [int]$report.version
    if ($reportVersion -le 0) {
        Fail-Step "reports" "AVAILABLE report is missing a positive version" $script:ExitVerify
    }
    $script:ArtifactSummary["pdf"] = "AVAILABLE"
    $script:ArtifactSummary["reportVersion"] = $reportVersion
    Add-Step "reports" "PASSED" ("PDF report version {0} is AVAILABLE" -f $reportVersion)

    $script:CurrentStep = "artifact-urls"
    $maskUrl = Get-SignedArtifactUrl -Path "/inferences/$inferenceId/artifacts/mask/url?version=$($catalog.Versions['mask'])" -Token $doctorSession.Token -StepName "artifact-urls"
    $overlayUrl = Get-SignedArtifactUrl -Path "/inferences/$inferenceId/artifacts/overlay/url?version=$($catalog.Versions['overlay'])" -Token $doctorSession.Token -StepName "artifact-urls"
    $reportUrl = Get-SignedArtifactUrl -Path "/inferences/$inferenceId/reports/$reportVersion/url" -Token $doctorSession.Token -StepName "artifact-urls"
    $script:Checks["maskExpiresInSeconds"] = $maskUrl.ExpiresInSeconds
    $script:Checks["overlayExpiresInSeconds"] = $overlayUrl.ExpiresInSeconds
    $script:Checks["reportExpiresInSeconds"] = $reportUrl.ExpiresInSeconds
    Add-Step "artifact-urls" "PASSED" "signed mask, overlay and report URLs issued"

    $script:CurrentStep = "downloads"
    $maskBytes = Get-DownloadBytes -Url $maskUrl.Url -StepName "downloads"
    Assert-PngMagic -Bytes $maskBytes -StepName "downloads"
    $overlayBytes = Get-DownloadBytes -Url $overlayUrl.Url -StepName "downloads"
    Assert-PngMagic -Bytes $overlayBytes -StepName "downloads"
    $pdfBytes = Get-DownloadBytes -Url $reportUrl.Url -StepName "downloads"
    Assert-PdfMagic -Bytes $pdfBytes -StepName "downloads"
    $script:Checks["maskMagic"] = "PNG"
    $script:Checks["overlayMagic"] = "PNG"
    $script:Checks["pdfMagic"] = "%PDF-"
    Add-Step "downloads" "PASSED" "mask/overlay PNG and PDF content validated"

    $script:CurrentStep = "feedback"
    $validatedClass = 0
    if ($null -ne $inference.predictedClass) {
        $parsedPredicted = 0
        if ([int]::TryParse([string]$inference.predictedClass, [ref]$parsedPredicted) -and $parsedPredicted -ge 0 -and $parsedPredicted -le 2) {
            $validatedClass = $parsedPredicted
        }
    }
    $feedbackPayload = [ordered]@{
        consultation_id  = $consultationId
        inference_id     = $inferenceId
        validated_class  = $validatedClass
        is_gold_standard = $true
        doctor_notes     = "Azure E2E validated"
    } | ConvertTo-Json -Compress
    $feedbackResponse = Invoke-Api -Method "POST" -Path "/feedback" -Headers (New-AuthHeaders $doctorSession.Token) -JsonBody $feedbackPayload
    Assert-HttpStatus $feedbackResponse @(200) "feedback"
    $feedbackBody = ConvertFrom-ApiJson $feedbackResponse "feedback"
    $storedValidated = [int]$feedbackBody.validated_class
    if ($storedValidated -ne $validatedClass) {
        Fail-Step "feedback" "feedback response did not preserve validated_class" $script:ExitVerify
    }
    $script:Checks["feedbackValidatedClass"] = $storedValidated
    $script:Checks["feedbackGoldStandard"] = [bool]$feedbackBody.is_gold_standard
    Add-Step "feedback" "PASSED" "clinical feedback stored"

    $script:CurrentStep = "export"
    $exportResponse = Invoke-Api -Method "GET" -Path "/export/gold-standard" -Headers (New-AuthHeaders $adminSession.Token)
    if ($exportResponse.Status -eq 200) {
        $exportBody = ConvertFrom-ApiJson $exportResponse "export"
        $script:Checks["exportStatus"] = "AVAILABLE"
        $script:Checks["exportCount"] = [int]$exportBody.count
        Add-Step "export" "PASSED" ("gold-standard export returned {0} row(s)" -f $exportBody.count)
    }
    elseif ($exportResponse.Status -eq 401 -or $exportResponse.Status -eq 403) {
        $script:Checks["exportStatus"] = "SKIPPED_NO_GRANT"
        Add-Step "export" "SKIPPED" ("admin export not authorized (HTTP {0})" -f $exportResponse.Status)
    }
    else {
        $script:Checks["exportStatus"] = "SKIPPED_UNAVAILABLE"
        Add-Step "export" "SKIPPED" ("admin export unavailable (HTTP {0})" -f $exportResponse.Status)
    }

    $script:CurrentStep = "delivery-recheck"
    $finalResponse = Invoke-Api -Method "GET" -Path "/inferences/$inferenceId" -Headers (New-AuthHeaders $doctorSession.Token)
    Assert-HttpStatus $finalResponse @(200) "delivery-recheck"
    $finalInference = ConvertFrom-ApiJson $finalResponse "delivery-recheck"
    $finalDelivery = $finalInference.delivery
    if ($null -eq $finalDelivery) {
        Fail-Step "delivery-recheck" "inference response is missing delivery state" $script:ExitVerify
    }
    if ($terminalStatus -eq "COMPLETED" -and -not [bool]$finalDelivery.complete) {
        Fail-Step "delivery-recheck" ("delivery incomplete (result={0}, evidence={1}, pdf={2})" -f $finalDelivery.resultStatus, $finalDelivery.evidenceStatus, $finalDelivery.pdfStatus) $script:ExitVerify
    }
    if ($terminalStatus -eq "REVIEW_REQUIRED" -and -not [bool]$finalDelivery.deliveryTerminal) {
        Fail-Step "delivery-recheck" "review delivery is not terminal" $script:ExitVerify
    }
    $script:Checks["deliveryComplete"] = [bool]$finalDelivery.complete
    Add-Step "delivery-recheck" "PASSED" "delivery state is consistent with the artifacts"

    Write-Host ""
    Write-Host "[clearsight] E2E Azure pipeline PASSED" -ForegroundColor Green
    Write-Host ("[clearsight] summary: {0}" -f $script:SummaryPath) -ForegroundColor Cyan
}
catch {
    if ($null -eq $script:Error) {
        $script:ExitCode = $script:ExitFlow
        $script:Error = [ordered]@{
            step    = $script:CurrentStep
            code    = $script:ExitCode
            message = "unexpected failure"
        }
        Add-Step $script:CurrentStep "FAILED" "unexpected failure"
    }
    Write-Host ("[clearsight] E2E Azure pipeline FAILED at {0}: {1}" -f $script:Error.step, $script:Error.message) -ForegroundColor Red
}
finally {
    try {
        Save-Summary
    }
    catch {
        Write-Host "[clearsight] could not write summary.json" -ForegroundColor Yellow
    }
}

exit $script:ExitCode
