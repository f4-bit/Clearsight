import { spawn } from "node:child_process";
import { Client } from "pg";
import {
  advisoryLockKeys,
  buildPrismaCliArgs,
  MigrationDeploymentError,
  type CliExecution,
  type DatabaseState,
  type MigrationRuntime,
  type PrismaMigrationCommand,
} from "../../src/services/migration-deployment.js";
import type { MigrationTarget } from "./migration-preflight.js";
import { inspectDatabase } from "./postgres-migration-introspection.js";

export interface PostgresMigrationRuntimeOptions {
  readonly target: MigrationTarget;
  readonly rootDir: string;
  readonly prismaCliPath: string;
  readonly configPath: string;
}

function safeRuntimeError(
  code:
    | "MIGRATION_CONNECTION_FAILED"
    | "MIGRATION_LOCK_FAILED"
    | "MIGRATION_LOCK_RELEASE_FAILED"
    | "MIGRATION_INTROSPECTION_FAILED"
    | "MIGRATION_CLI_FAILED",
  phase: "lock" | "inspect" | "resolve" | "deploy",
  message: string,
): MigrationDeploymentError {
  return new MigrationDeploymentError(code, phase, message);
}

export function createPostgresMigrationRuntime(
  options: PostgresMigrationRuntimeOptions,
): MigrationRuntime {
  const { target, rootDir, prismaCliPath, configPath } = options;
  const [lockKey1, lockKey2] = advisoryLockKeys(target.database, target.schema);
  let client: Client | undefined;
  let lockHeld = false;

  async function runPrisma(command: PrismaMigrationCommand): Promise<CliExecution> {
    const phase = command === "resolve-0-init" ? "resolve" : "deploy";
    const args = buildPrismaCliArgs(command, { prismaCliPath, configPath });
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      // The DSN travels only through the child environment, never argv.
      DATABASE_URL: target.url,
      MIGRATION_DATABASE_URL: target.url,
      // Keep the CLI local and deterministic; no update/telemetry calls.
      CHECKPOINT_DISABLE: "1",
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
      NO_COLOR: "1",
    };

    return new Promise<CliExecution>((resolve, reject) => {
      let settled = false;
      let child: ReturnType<typeof spawn>;

      try {
        child = spawn(process.execPath, args, {
          cwd: rootDir,
          env: environment,
          // Discard output entirely: Prisma errors may contain URLs or hosts.
          stdio: ["ignore", "ignore", "ignore"],
          windowsHide: true,
        });
      } catch {
        reject(safeRuntimeError("MIGRATION_CLI_FAILED", phase, "the Prisma CLI could not be started"));
        return;
      }

      child.once("error", () => {
        if (settled) {
          return;
        }
        settled = true;
        reject(safeRuntimeError("MIGRATION_CLI_FAILED", phase, "the Prisma CLI could not be started"));
      });

      child.once("close", (exitCode) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({ exitCode });
      });
    });
  }

  return {
    async acquireLock(): Promise<void> {
      if (client !== undefined) {
        return;
      }

      const connection = new Client({
        connectionString: target.url,
        application_name: "clearsight-migrate-deploy",
      });

      try {
        await connection.connect();
      } catch {
        try {
          await connection.end();
        } catch {
          // The connection never opened; there is nothing else to release.
        }
        throw safeRuntimeError(
          "MIGRATION_CONNECTION_FAILED",
          "lock",
          "the migration database connection could not be established",
        );
      }

      try {
        await connection.query("SELECT pg_catalog.pg_advisory_lock($1::int, $2::int)", [
          lockKey1,
          lockKey2,
        ]);
      } catch {
        try {
          await connection.end();
        } catch {
          // Best effort: the lock query already failed.
        }
        throw safeRuntimeError(
          "MIGRATION_LOCK_FAILED",
          "lock",
          "the migration advisory lock could not be acquired",
        );
      }

      client = connection;
      lockHeld = true;
    },

    async inspect(): Promise<DatabaseState> {
      if (client === undefined) {
        throw safeRuntimeError(
          "MIGRATION_CONNECTION_FAILED",
          "inspect",
          "the migration database connection is not available",
        );
      }

      const connection = client;
      try {
        await connection.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await connection.query("SET LOCAL search_path = pg_catalog");
        const state = await inspectDatabase(connection, target.schema);
        await connection.query("COMMIT");
        return state;
      } catch {
        try {
          await connection.query("ROLLBACK");
        } catch {
          // Best effort: report the stable introspection failure below.
        }
        throw safeRuntimeError(
          "MIGRATION_INTROSPECTION_FAILED",
          "inspect",
          "read-only migration introspection failed",
        );
      }
    },

    async resolveApplied(_migrationName: string): Promise<CliExecution> {
      return runPrisma("resolve-0-init");
    },

    async deploy(): Promise<CliExecution> {
      return runPrisma("deploy");
    },

    async releaseLock(): Promise<void> {
      const connection = client;
      client = undefined;
      if (connection === undefined) {
        lockHeld = false;
        return;
      }

      let failure = false;
      try {
        if (lockHeld) {
          const result = await connection.query<{ released: boolean }>(
            "SELECT pg_catalog.pg_advisory_unlock($1::int, $2::int) AS released",
            [lockKey1, lockKey2],
          );
          if (result.rows[0]?.released !== true) {
            failure = true;
          }
        }
      } catch {
        failure = true;
      } finally {
        lockHeld = false;
        try {
          await connection.end();
        } catch {
          failure = true;
        }
      }

      if (failure) {
        throw safeRuntimeError(
          "MIGRATION_LOCK_RELEASE_FAILED",
          "lock",
          "the migration advisory lock could not be released",
        );
      }
    },
  };
}
