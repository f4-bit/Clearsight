# Azure Readiness and Init SQL — Initial Capability

> Capacidad inicial del repo registrada como `ADDED`. No existe baseline versionada de esta capacidad; el contenido es autosuficiente para un clon limpio.

## ADDED Requirements

### Requirement: Database Schema Initialization (init.sql)

The system SHALL provide an idempotent initialization script `docker/init.sql` creating the baseline clinical tables `patients`, `consultations`, `images`, `inferences`, and `clinical_feedback` (including `is_gold_standard` boolean index, JSONB clinical data, and foreign key relationships), mounted into PostgreSQL in `docker-compose.yml`. The migration path MUST add the consolidation schema for clinical snapshots, executions with explicit `requiredExecutionIds`/`requiredSetVersion`, artifact records, PDF report versions, append-only audit events, persisted idempotency records and durable sessions (`sessionId`/`tokenVersion`) through incremental migrations. The system MUST condition the resolution of the `0_init` baseline on a verified schema instead of applying `prisma migrate resolve --applied 0_init` indiscriminately, so a real schema divergence is reported rather than masked. The schema MUST retain the canonical job vocabulary `QUEUED`, `DOWNLOADING`, `LOCALIZING`, `SEGMENTING`, `CLASSIFYING`, `COMPLETED`, `REVIEW_REQUIRED`, `FAILED` and MUST NOT add a `PROCESSING` enum value without an explicit migration.

#### Scenario: Database container bootstrap

- **WHEN** the PostgreSQL service is started with `docker compose` on an empty database
- **THEN** the baseline tables `patients`, `consultations`, `images`, `inferences`, and `clinical_feedback` are created automatically without error
- **AND** the incremental migrations add the consolidation tables and columns.

#### Scenario: Existing baseline schema

- **WHEN** the database already contains the verified `0_init` baseline
- **THEN** the migration marks the baseline as applied only after verifying the expected schema
- **AND** continues with pending migrations without recreating objects.

#### Scenario: Divergent schema

- **WHEN** the database schema does not match the verified baseline
- **THEN** the migration fails with a clear error instead of resolving `0_init` indiscriminately
- **AND** does not silently skip pending migrations.

#### Scenario: Status vocabulary preserved

- **WHEN** migrations or code write an execution status
- **THEN** the value belongs to the canonical `JobStatus` vocabulary
- **AND** no `PROCESSING` value is introduced without a migration and contract update.

### Requirement: ONNX Runtime Inference Backend Switch

The system SHALL support selecting between PyTorch and ONNX Runtime classification via configuration `Settings.inference_backend` (`ML_INFERENCE_BACKEND`), configuring `build_runtime` in `ml/service/main.py` to instantiate `OnnxClassificationRunner` when `"onnx"` is specified.

#### Scenario: Runtime instantiation with ONNX backend

- **WHEN** `build_runtime` is called with `settings.inference_backend = "onnx"`
- **THEN** the classification engine is instantiated using `OnnxClassificationRunner`.

### Requirement: Azure Blob Storage Host Compatibility

The system SHALL enhance `_download_image` in `ml/inference/pipeline.py` to support wildcard host matching (such as `*.blob.core.windows.net`), allowing pre-signed URLs from Azure Blob Storage.

#### Scenario: Azure Blob signed URL validation

- **WHEN** an image URL hosted on `clearsight.blob.core.windows.net` is provided and `*.blob.core.windows.net` is in `allowed_signed_url_hosts`
- **THEN** host validation succeeds and does not throw an SSRF rejection error.

### Requirement: Database Feedback Source for Retraining

The system SHALL treat `DatabaseFeedbackSource` and any SQLAlchemy-based feedback query as optional and pending explicit product decision. The system MUST NOT add `SQLAlchemy` to `ml/pyproject.toml` or implement the database feedback source automatically as part of this change. If the capability is implemented later, it MUST query only `clinical_feedback` rows where `is_gold_standard = TRUE`, joined with the necessary consultation data, when the corresponding CLI flag is provided.

#### Scenario: Feedback source not implemented

- **WHEN** the retraining cycle runs without a decision to implement the database feedback source
- **THEN** it uses the supported feedback input and does not import a missing SQLAlchemy dependency
- **AND** the system does not fail at startup because of an optional dependency.

#### Scenario: Future database feedback source

- **WHEN** the product approves and implements `DatabaseFeedbackSource`
- **THEN** it queries only gold-standard feedback joined with consultation data
- **AND** the dependency is declared explicitly in `ml/pyproject.toml`.

### Requirement: Operational Dockerfiles for Auxiliary Services

The system SHALL provide functional Dockerfile definitions in `docker/backend.Dockerfile`, `docker/worker.Dockerfile`, and `docker/frontend.Dockerfile` that successfully build with Docker BuildKit.

#### Scenario: Docker compose build

- **WHEN** `docker compose build` is executed
- **THEN** all auxiliary service images build successfully.
