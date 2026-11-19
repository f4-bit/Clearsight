import type { FastifyRequest } from "fastify";
import type { UserRole } from "../generated/prisma/enums.js";
import type { PatientModel } from "../generated/prisma/models/Patient.js";
import { forbidden, notFound, unauthorized } from "../lib/http-error.js";
import {
  assertValidDatabaseSchema,
  DEFAULT_DATABASE_SCHEMA,
} from "../lib/postgres-schema.js";
import type { PrismaClient } from "../lib/prisma.js";

/**
 * Clinical authorization service (Hito 5.2).
 *
 * Every method receives the principal built from the authenticated request, so
 * the JWT-validated identity is authoritative and the body can never supply an
 * owner, doctor or recipient. Construction is lazy: it never queries or opens a
 * connection, and the caller can only inject the same client the routes mutate.
 */

export interface ClinicalSubject {
  readonly id: string;
  readonly role: UserRole;
}

/** The four independent permissions a grant can carry. */
export type GrantCapability =
  | "readResult"
  | "readArtifacts"
  | "readPdf"
  | "canExportGoldStandard";

export interface ActiveGrantFlags {
  readonly readResult: boolean;
  readonly readArtifacts: boolean;
  readonly readPdf: boolean;
  readonly canExportGoldStandard: boolean;
}

export interface ExportPair {
  readonly inferenceId: string;
  readonly consultationId: string;
}

export interface ClinicalAccessService {
  /** 403 unless the principal is an OFTALMOLOGO. */
  assertDoctor(subject: ClinicalSubject): void;
  /** 403 unless the principal is an ADMIN/INVESTIGADOR dataset role. */
  assertDatasetRole(subject: ClinicalSubject): void;

  listOwnedPatients(
    subject: ClinicalSubject,
    opts: { limit: number; offset: number },
  ): Promise<PatientModel[]>;
  getOwnedPatient(subject: ClinicalSubject, patientId: string): Promise<PatientModel>;

  getOwnedConsultation(
    subject: ClinicalSubject,
    consultationId: string,
    includeImages: boolean,
  ): Promise<any>;
  getOwnedImageContext(
    subject: ClinicalSubject,
    imageId: string,
  ): Promise<{ image: any; consultation: any }>;

  getInferenceForRead(
    subject: ClinicalSubject,
    inferenceId: string,
    capability: Extract<GrantCapability, "readResult" | "readArtifacts" | "readPdf">,
  ): Promise<{ inference: any; grant: ActiveGrantFlags | null; redactGradcamPath: boolean }>;

  /** 403 unless there is at least one active export grant for the principal. */
  assertExportGrant(subject: ClinicalSubject): Promise<void>;
  listActiveExportPairs(subject: ClinicalSubject): Promise<ExportPair[]>;
}

export interface ClinicalAccessServiceOptions {
  readonly databaseSchema?: string;
  readonly now?: () => Date;
}

/** Reads the verified principal only; there is no NODE_ENV or header bypass. */
export function subjectFromRequest(
  request: Pick<FastifyRequest, "authenticatedUser">,
): ClinicalSubject {
  const principal = request.authenticatedUser;
  if (!principal) {
    throw unauthorized();
  }
  return { id: principal.id, role: principal.role };
}

const CAPABILITY_COLUMN: Record<GrantCapability, keyof ActiveGrantFlags> = {
  readResult: "readResult",
  readArtifacts: "readArtifacts",
  readPdf: "readPdf",
  canExportGoldStandard: "canExportGoldStandard",
};

export function createClinicalAccessService(
  db: PrismaClient,
  options: ClinicalAccessServiceOptions = {},
): ClinicalAccessService {
  const databaseSchema = options.databaseSchema ?? DEFAULT_DATABASE_SCHEMA;
  assertValidDatabaseSchema(databaseSchema);
  const now = options.now ?? (() => new Date());

  function assertDoctor(subject: ClinicalSubject): void {
    if (subject.role !== "OFTALMOLOGO") {
      throw forbidden("Clinical write and patient access require the OFTALMOLOGO role");
    }
  }

  function assertDatasetRole(subject: ClinicalSubject): void {
    if (subject.role !== "ADMIN" && subject.role !== "INVESTIGADOR") {
      throw forbidden("This dataset action requires an ADMIN or INVESTIGADOR role");
    }
  }

  async function listOwnedPatients(
    subject: ClinicalSubject,
    opts: { limit: number; offset: number },
  ) {
    assertDoctor(subject);
    return db.patient.findMany({
      where: { ownerDoctorId: subject.id },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: opts.limit,
      skip: opts.offset,
    });
  }

  async function getOwnedPatient(subject: ClinicalSubject, patientId: string) {
    assertDoctor(subject);
    const patient = await db.patient.findFirst({
      where: { id: patientId, ownerDoctorId: subject.id },
    });
    if (patient === null) {
      // A NULL-owner legacy profile is invisible even to the doctor that owns a
      // legacy consultation: privacy denies the unknown patient profile.
      throw notFound("Patient");
    }
    return patient;
  }

  async function getOwnedConsultation(
    subject: ClinicalSubject,
    consultationId: string,
    includeImages: boolean,
  ) {
    assertDoctor(subject);
    const consultation = await db.consultation.findFirst({
      where: { id: consultationId, doctorId: subject.id },
      ...(includeImages
        ? { include: { images: { orderBy: { eyeSide: "asc" as const } } } }
        : {}),
    });
    if (consultation === null) {
      throw notFound("Consultation");
    }
    return consultation;
  }

  async function getOwnedImageContext(subject: ClinicalSubject, imageId: string) {
    assertDoctor(subject);
    const image = await db.image.findFirst({
      where: { id: imageId, consultation: { doctorId: subject.id } },
      include: { consultation: true },
    });
    if (image === null) {
      throw notFound("Image");
    }
    return { image, consultation: image.consultation };
  }

  async function findActiveGrant(
    subject: ClinicalSubject,
    inferenceId: string,
    capability: GrantCapability,
  ): Promise<ActiveGrantFlags | null> {
    const column = CAPABILITY_COLUMN[capability];
    const grant = await db.inferenceAccessGrant.findFirst({
      where: {
        inferenceId,
        recipientUserId: subject.id,
        revokedAt: null,
        expiresAt: { gt: now() },
        [column]: true,
      },
      select: {
        readResult: true,
        readArtifacts: true,
        readPdf: true,
        canExportGoldStandard: true,
      },
    });
    return grant;
  }

  async function getInferenceForRead(
    subject: ClinicalSubject,
    inferenceId: string,
    capability: Extract<GrantCapability, "readResult" | "readArtifacts" | "readPdf">,
  ) {
    if (subject.role === "OFTALMOLOGO") {
      const inference = await db.inference.findFirst({
        where: { id: inferenceId, image: { consultation: { doctorId: subject.id } } },
      });
      if (inference === null) {
        throw notFound("Inference");
      }
      return { inference, grant: null, redactGradcamPath: false };
    }

    if (subject.role !== "ADMIN" && subject.role !== "INVESTIGADOR") {
      throw forbidden("This clinical read is not authorized for the current role");
    }

    // Foreign or ungranted executions share one uniform 404 (no enumeration).
    const grant = await findActiveGrant(subject, inferenceId, capability);
    if (grant === null) {
      throw notFound("Inference");
    }

    const inference = await db.inference.findUnique({ where: { id: inferenceId } });
    if (inference === null) {
      throw notFound("Inference");
    }

    // Non-doctors never receive the legacy inline gradcam path unless they hold
    // the explicit artifact capability; the URL endpoint is the safe surface.
    return {
      inference,
      grant,
      redactGradcamPath: !grant.readArtifacts,
    };
  }

  async function assertExportGrant(subject: ClinicalSubject): Promise<void> {
    assertDatasetRole(subject);
    const grant = await db.inferenceAccessGrant.findFirst({
      where: {
        recipientUserId: subject.id,
        revokedAt: null,
        expiresAt: { gt: now() },
        canExportGoldStandard: true,
      },
      select: { id: true },
    });
    if (grant === null) {
      throw forbidden("No active gold-standard export grant for this account");
    }
  }

  async function listActiveExportPairs(subject: ClinicalSubject): Promise<ExportPair[]> {
    assertDatasetRole(subject);
    const rows = await db.inferenceAccessGrant.findMany({
      where: {
        recipientUserId: subject.id,
        revokedAt: null,
        expiresAt: { gt: now() },
        canExportGoldStandard: true,
      },
      select: { inferenceId: true, consultationId: true },
      orderBy: [{ inferenceId: "asc" }, { consultationId: "asc" }],
    });
    return rows.map((row) => ({
      inferenceId: row.inferenceId,
      consultationId: row.consultationId,
    }));
  }

  return {
    assertDoctor,
    assertDatasetRole,
    listOwnedPatients,
    getOwnedPatient,
    getOwnedConsultation,
    getOwnedImageContext,
    getInferenceForRead,
    assertExportGrant,
    listActiveExportPairs,
  };
}
