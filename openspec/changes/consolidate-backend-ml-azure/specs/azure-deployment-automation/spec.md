# Azure Deployment Automation — Initial Capability

> Capacidad inicial del repo registrada como `ADDED`. No existe baseline versionada de esta capacidad; el contenido es autosuficiente para un clon limpio.

## ADDED Requirements

### Requirement: Azure Infrastructure Provisioning Automation

The system SHALL provide an automated deployment script that provisions Azure resources in a run-scoped, isolated resource group with a unique prefix and environment tags, targeting a configurable location. The script SHALL create Blob Storage containers, ACR, PostgreSQL Flexible Server (initializing the database only after schema verification), and configure Azure Container Apps with `ML_INFERENCE_BACKEND=onnx`. The script MUST require confirmed subscription, resource scope, numeric budget and maximum duration before creating anything; otherwise the deployment MUST remain blocked. The script MUST write a manifest of created resources and MUST clean them up in `finally` without deleting pre-existing resources owned by others. The legacy fixed resource group `rg-clearsight-eastus2` MUST NOT be assumed for new runs.

#### Scenario: Script structure and isolated provisioning

- **WHEN** the deployment script is executed with confirmed subscription, scope, budget, duration and authenticated Azure CLI
- **THEN** it validates authentication, creates a run-scoped resource group with tags, provisions the declared resources, writes a run manifest, and outputs safe deployment identifiers
- **AND** it does not reuse or delete resources that were not created by the run.

#### Scenario: Missing deployment decisions

- **WHEN** subscription, resource scope, numeric budget or maximum duration is not confirmed
- **THEN** the script aborts before creating any resource
- **AND** reports the missing decision without reading `.env.azure` or printing secrets.

#### Scenario: Cleanup of a run

- **WHEN** the deployment finishes, fails or is interrupted
- **THEN** the cleanup uses the run manifest in `finally` or in a separate cleanup execution
- **AND** verifies asynchronous deletions and reports residual resources as pending.

### Requirement: E2E Pipeline Verification

The system SHALL provide an end-to-end verification script `scripts/test_azure_e2e.py` capable of testing the deployed ML service or local instance with synthetic multimodal inputs (retinal image and 11 clinical features), asserting health, job completion, CDR calculations, and class probabilities.

#### Scenario: End-to-end inference verification

- **WHEN** `test_azure_e2e.py` is invoked against an active Clearsight ML service endpoint
- **THEN** it completes inference verification, checks status 200/ACCEPTED, and asserts that predicted_class, confidence, and probabilities are properly formatted.
