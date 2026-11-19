import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import {
  bootstrapAdmin,
  BootstrapAdminError,
  safeBootstrapFailure,
  validateBootstrapAdminInput,
} from "../src/services/admin-bootstrap.js";
import {
  resolveMigrationDatabaseUrl,
  type MigrationTarget,
} from "./helpers/migration-preflight.js";

/**
 * Controlled first-administrator CLI.
 *
 * Credentials are consumed only from BOOTSTRAP_ADMIN_* environment variables;
 * there is no --password argument and no dotenv/.env loading. The database is
 * an explicitly supplied owned target (MIGRATION_DATABASE_URL or DATABASE_URL),
 * never a localhost fallback. Stdio is limited to a stable code and an optional
 * admin UUID; emails, passwords, hashes and DSNs are never printed.
 *
 * Exit codes: 0 = committed and cleaned up; 1 = operation failed (the primary
 * error is preserved even if cleanup also fails); 2 = committed but cleanup is
 * pending. An ambiguous network error is never reported as a rollback and the
 * CLI never retries automatically.
 */
export function createBootstrapPrismaClient(target: MigrationTarget): PrismaClient {
  // The schema lives in the adapter options; the DSN's `schema` query alone is
  // ignored by the generated client.
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: target.url }, { schema: target.schema }),
    log: [],
  });
}

function resolveBootstrapTarget(environment: NodeJS.ProcessEnv): MigrationTarget {
  try {
    return resolveMigrationDatabaseUrl(environment);
  } catch {
    throw new BootstrapAdminError(
      "BOOTSTRAP_CONFIG_INVALID",
      "set MIGRATION_DATABASE_URL (preferred) or DATABASE_URL to an owned database",
    );
  }
}

function readBootstrapInput(environment: NodeJS.ProcessEnv): unknown {
  return {
    email: environment.BOOTSTRAP_ADMIN_EMAIL,
    fullName: environment.BOOTSTRAP_ADMIN_FULL_NAME,
    password: environment.BOOTSTRAP_ADMIN_PASSWORD,
  };
}

export interface BootstrapCliWriters {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Test seam for the controlled module; the CLI defaults to the real factory. */
export type BootstrapClientFactory = (target: MigrationTarget) => PrismaClient;

const EXIT_SUCCESS = 0;
const EXIT_OPERATION_FAILED = 1;
const EXIT_COMMITTED_CLEANUP_PENDING = 2;
const DISCONNECT_WARNING =
  "[bootstrap] warning code=BOOTSTRAP_DISCONNECT_FAILED message=the bootstrap database connection could not be closed";

const DEFAULT_WRITERS: BootstrapCliWriters = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export async function runBootstrapAdminCli(
  environment: NodeJS.ProcessEnv = process.env,
  writers: BootstrapCliWriters = DEFAULT_WRITERS,
  createClient: BootstrapClientFactory = createBootstrapPrismaClient,
): Promise<number> {
  let client: PrismaClient | undefined;
  let result: { id: string; role: string } | undefined;
  let failure: { code: string; message: string } | undefined;
  let cleanupFailed = false;

  try {
    // Validate configuration and input before constructing the client, so an
    // invalid invocation never reaches a network path.
    const target = resolveBootstrapTarget(environment);
    const input = validateBootstrapAdminInput(readBootstrapInput(environment));

    client = createClient(target);
    const bootstrapResult = await bootstrapAdmin(client, input);
    result = { id: bootstrapResult.id, role: bootstrapResult.role };
  } catch (error) {
    failure = safeBootstrapFailure(error);
  } finally {
    if (client) {
      try {
        await client.$disconnect();
      } catch {
        cleanupFailed = true;
      }
    }
  }

  // A known result means the transaction committed. Cleanup is a separate
  // outcome; it must never turn a committed bootstrap into "failed" or imply
  // a rollback.
  if (result !== undefined) {
    writers.out(
      `[bootstrap] ok userId=${result.id} role=${result.role} operationStatus=COMMITTED cleanup=${
        cleanupFailed ? "PENDING" : "COMPLETE"
      }`,
    );
    if (cleanupFailed) {
      writers.err(DISCONNECT_WARNING);
      return EXIT_COMMITTED_CLEANUP_PENDING;
    }
    return EXIT_SUCCESS;
  }

  if (failure !== undefined) {
    writers.err(`[bootstrap] failed code=${failure.code} message=${failure.message}`);
    if (cleanupFailed) {
      writers.err(DISCONNECT_WARNING);
    }
    return EXIT_OPERATION_FAILED;
  }

  writers.err("[bootstrap] failed code=BOOTSTRAP_UNEXPECTED message=unexpected bootstrap failure");
  return EXIT_OPERATION_FAILED;
}

async function main(): Promise<void> {
  process.exitCode = await runBootstrapAdminCli();
}

const invokedPath = process.argv[1];
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath !== undefined && resolve(invokedPath) === resolve(modulePath)) {
  void main();
}
