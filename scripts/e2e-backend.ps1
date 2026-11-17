<#
.SYNOPSIS
  Clearsight backend E2E runbook (clinical flow).

.DESCRIPTION
  Drives the deployed backend from the host through the full clinical pipeline:
    1. POST /auth/login            (doctor credentials from prisma seed)
    2. POST /patients              (creates a pseudonymized patient record)
    3. POST /consultations         (opens a pending consultation)
    4. POST /consultations/:id/images  (raw JPG with EXIF -> sanitized + S3/MinIO)
    5. POST /inferences            (enqueue OD inference to ML via BullMQ)
    6. Poll GET /inferences/:id    (wait until the worker fills in prediction)
    7. POST /feedback              (doctor confirms gold-standard label)

.NOTES
  Preconditions (i.e. the environment this script drives):
    - Docker Desktop running
    - External network created once: docker network create clearsight
    - MinIO + Postgres + backend + worker compose stack is up:
        docker compose up -d postgres minio backend worker
    - ML service (separate compose, same `clearsight` network) is up and healthy:
        docker compose -f docker/ml-service.compose.yml up -d
    - PostgreSQL schema migrated AND seeded:
        docker compose exec backend npx prisma migrate deploy
        docker compose exec backend npm run prisma:seed
    - The image pipeline requires the MinIO presigned URL to be reachable
      from the ML service (ML_PUBLIC_HOST=minio:9000 in backend env).

  The script is resilient to the ML side being unavailable: after step 5 the
  inference row will stay in QUEUED state if BullMQ cannot reach MLCONTAINER,
  in which case step 6 exits with a clear message instead of hanging.

  Safest invocation:
    powershell -ExecutionPolicy Bypass -File .\scripts\e2e-backend.ps1 -BaseUrl http://localhost:8080

.PARAMETER BaseUrl
  Public URL of the backend (host:port for the Docker mapping, default 8080:8000).
.PARAMETER Email
  Doctor credentials from the seed (default doctor1@clearsight.test).
.PARAMETER Password
  Seed password (default ChangeMe123!, the SEED_PASSWORD default).
.PARAMETER TimeoutSec
  Seconds to poll /inferences/:id before declaring the worker offline (default 180).
.PARAMETER KeepTemp
  Keep the generated test image in $env:TEMP for inspection/debugging.
#>
[CmdletBinding()]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', '', Justification = 'Local E2E runbook: the seed password must be passed as a plain string to Invoke-RestMethod.')]
param(
  [string]$BaseUrl = "http://localhost:8080",
  [string]$Email = "doctor1@clearsight.test",
  [string]$Password = "ChangeMe123!",
  [int]$TimeoutSec = 180,
  [switch]$KeepTemp
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TempDir = Join-Path $env:TEMP ("clearsight-e2e-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

# Generate a valid synthetic retinography-shaped JPEG in runtime (no binary in git).
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap(512, 512)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::White)
$graphics.FillEllipse([System.Drawing.Brushes]::Black, 16, 16, 32, 32)
$graphics.Dispose()
$TestJpegPath = Join-Path $TempDir "sample_od.jpg"
$bitmap.Save($TestJpegPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bitmap.Dispose()
Write-Host "[e2e] test image -> $TestJpegPath"

function Step($name) {
  Write-Host ""
  Write-Host "===== $name =====" -ForegroundColor Cyan
}

function Invoke-Json($method, $url, $token, $body) {
  $headers = @{ Authorization = "Bearer $token" }
  $params = @{ Method = $method; Uri = $url; Headers = $headers }
  if ($null -ne $body) {
    $params.ContentType = "application/json"
    $params.Body = ($body | ConvertTo-Json -Depth 8)
  }
  try {
    return Invoke-RestMethod @params
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    $detail = $_.ErrorDetails.Message
    Write-Host "[e2e] HTTP $status from $method $url" -ForegroundColor Red
    Write-Host "[e2e] $detail" -ForegroundColor Red
    throw "request failed: $method $url (HTTP $status)"
  }
}

try {
  Step "1/7 Login as doctor"
  $login = Invoke-Json "POST" "$BaseUrl/auth/login" $null @{ email = $Email; password = $Password }
  $token = $login.accessToken
  if (-not $token) { throw "no accessToken in login response" }
  Write-Host "[e2e] logged in as $Email (role=$($login.user.role))"

  Step "2/7 Create patient"
  $clinicalData = @{
    Age = 64; Gender = 0; dioptre_1 = 0.5; dioptre_2 = -0.75; astigmatism = 90;
    "Phakic/Pseudophakic" = 1; Pneumatic = 16.5; Perkins = 16.0; Pachymetry = 540;
    Axial_Length = 23.5; VF_DM = -2.1
  }
  $patientBody = @{
    externalCode = "E2E-$(Get-Random -Maximum 100000)"
    age = 64
    gender = "F"
    clinicalHistoryFlags = @{ family_glaucoma = $true; hypertension = $true; diabetes = $false }
    clinicalData = $clinicalData
  }
  $patient = Invoke-Json "POST" "$BaseUrl/patients" $token $patientBody
  $patientId = $patient.id
  Write-Host "[e2e] patient created: $patientId"

  Step "3/7 Open consultation"
  $consultation = Invoke-Json "POST" "$BaseUrl/consultations" $token @{
    patientId = $patientId
    status = "QUEUED"
    clinicalData = $clinicalData
  }
  $consultationId = $consultation.id
  Write-Host "[e2e] consultation: $consultationId"

  Step "4/7 Upload retinography (OD) with sanitization"
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if (-not $curl) { throw "curl.exe not found on PATH (Windows 10+ required)" }
  $uploadUrl = "$BaseUrl/consultations/$consultationId/images"
  $uploadResult = (& curl.exe -s -X POST `
    -H "Authorization: Bearer $token" `
    -F "eyeSide=OD" `
    -F "image=@$TestJpegPath;type=image/jpeg" `
    -w "`nHTTP_STATUS:%{http_code}" `
    $uploadUrl 2>&1 | Out-String)
  $codeMatch = [regex]::Match($uploadResult, "HTTP_STATUS:(\d+)")
  $httpCode = if ($codeMatch.Success) { $codeMatch.Groups[1].Value } else { "unknown" }
  Write-Host "[e2e] upload HTTP $httpCode"
  if ($httpCode -ne "201") {
    Write-Host "[e2e] upload response: $($uploadResult.Trim())" -ForegroundColor Red
    throw "image upload failed with HTTP $httpCode"
  }
  $imageLine = ($uploadResult -split "`r?`n") | Where-Object { $_ -match "^\{" } | Select-Object -Last 1
  $image = $imageLine | ConvertFrom-Json
  $imageId = $image.id
  Write-Host "[e2e] image sanitized: $imageId (hash=$($image.hashMd5))"

  Step "5/7 Enqueue ML inference (BullMQ -> ml-service)"
  $inference = Invoke-Json "POST" "$BaseUrl/inferences" $token @{
    imageId = $imageId
    eyeSide = "OD"
    clinicalFeatures = $clinicalData
    modelVersion = "v1.0.0-onnx"
  }
  $inferenceId = $inference.inferenceId
  $jobId = $inference.jobId
  Write-Host "[e2e] inference queued: inferenceId=$inferenceId jobId=$jobId"

  Step "6/7 Poll /inferences/:id (worker should fill prediction)"
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $result = $null
  do {
    Start-Sleep -Seconds 2
    $current = Invoke-Json "GET" "$BaseUrl/inferences/$inferenceId" $token
    $pred = $current.predictedClass
    Write-Host ("[e2e] poll: predictedClass={0} confidence={1} status={2}" -f $pred, $current.confidence, $(if ($null -ne $pred) { "COMPLETED" } else { "PENDING" }))
    if ($null -ne $pred) { $result = $current; break }
  } while ((Get-Date) -lt $deadline)

  if (-not $result) {
    Write-Host "[e2e] prediction not ready after ${TimeoutSec}s." -ForegroundColor Yellow
    Write-Host "[e2e] -> backend worker probably cannot reach ml-service. Check:" -ForegroundColor Yellow
    Write-Host "[e2e]    - both composes share the external 'clearsight' network" -ForegroundColor Yellow
    Write-Host "[e2e]    - docker network inspect clearsight" -ForegroundColor Yellow
    Write-Host "[e2e]    - docker compose -f docker/ml-service.compose.yml logs ml-service" -ForegroundColor Yellow
    exit 2
  }

  Step "7/7 Doctor feedback (gold-standard)"
  $feedback = Invoke-Json "POST" "$BaseUrl/feedback" $token @{
    consultation_id = $consultationId
    inference_id = $inferenceId
    validated_class = $result.predictedClass
    doctor_notes = "E2E validation: confirmed model prediction."
    is_gold_standard = $true
  }
  Write-Host "[e2e] feedback recorded: $($feedback.id) (gold-standard)"

  Step "+1 Gold-standard export (INVESTIGADOR)"
  $researcherLogin = Invoke-Json "POST" "$BaseUrl/auth/login" $null @{
    email = "researcher@clearsight.test"
    password = $Password
  }
  $researcherToken = $researcherLogin.accessToken
  $export = Invoke-Json "GET" "$BaseUrl/export/gold-standard?format=json&limit=10" $researcherToken
  Write-Host "[e2e] gold-standard rows: $($export.count) (has_more=$($export.has_more))"

  Write-Host ""
  Write-Host "==================== E2E OK ====================" -ForegroundColor Green
  Write-Host "patientId      : $patientId"
  Write-Host "consultationId : $consultationId"
  Write-Host "imageId        : $imageId"
  Write-Host "inferenceId    : $inferenceId"
  Write-Host "predictedClass : $($result.predictedClass)"
  exit 0
}
catch {
  Write-Host ""
  Write-Host "==================== E2E FAILED ====================" -ForegroundColor Red
  Write-Host $_.Exception.Message
  exit 1
}
finally {
  if (-not $KeepTemp) { Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue }
}
