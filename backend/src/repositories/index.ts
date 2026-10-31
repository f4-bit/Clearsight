import type { Db } from "./types.js";
import { createConsultationRepository } from "./consultation.repo.js";
import { createFeedbackRepository } from "./feedback.repo.js";
import { createImageRepository } from "./image.repo.js";
import { createInferenceRepository } from "./inference.repo.js";
import { createPatientRepository } from "./patient.repo.js";
import { createUserRepository } from "./user.repo.js";

/** All repositories bound to one client (or one transaction). */
export function createRepositories(db: Db) {
  return {
    users: createUserRepository(db),
    patients: createPatientRepository(db),
    consultations: createConsultationRepository(db),
    images: createImageRepository(db),
    inferences: createInferenceRepository(db),
    feedback: createFeedbackRepository(db),
  };
}
export type Repositories = ReturnType<typeof createRepositories>;
