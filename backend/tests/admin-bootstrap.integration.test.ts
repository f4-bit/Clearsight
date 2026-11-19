import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { Client } from "pg";
import fastifyJwt from "@fastify/jwt";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";
import bcrypt from "bcryptjs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { authRoutes } from "../src/routes/auth.js";
import { prisma as singletonPrisma, type PrismaClient } from "../src/lib/prisma.js";
import {
  ADMIN_LIFECYCLE_LOCK_KEY,
  BOOTSTRAP_BCRYPT_COST,
  BootstrapAdminError,
  bootstrapAdmin,
} from "../src/services/admin-bootstrap.js";
import {
  runBootstrapAdminCli,
  type BootstrapClientFactory,
  type BootstrapCliWriters,
} from "../scripts/bootstrap-admin.js";
import { createTestPrisma, resetDb } from "./helpers/db.js";
import { applyMigrations } from "./helpers/migrations.js";

const prisma = createTestPrisma();
const execFileAsync = promisify(execFile);
const backendRoot = fileURLToPath(new URL("..", import.meta.url));
const tsxCliPath = resolve(backendRoot, "node_modules", "tsx", "dist", "cli.mjs");
const bootstrapScriptPath = resolve(backendRoot, "scripts", "bootstrap-admin.ts");

const PASSWORD = "synthetic-bootstrap-password-123";
const EMAIL = "bootstrap-admin@clearsight.test";
const FULL_NAME = "Synthetic Bootstrap Admin";

function ownedDatabaseUrl(): string {
  const url = inject("databaseUrl");
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("Integration test context is missing the ephemeral database URL");
  }
  return url;
}

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

function childEnvironment(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "MIGRATION_DATABASE_URL",
    "DATABASE_URL",
    "BOOTSTRAP_ADMIN_EMAIL",
    "BOOTSTRAP_ADMIN_FULL_NAME",
    "BOOTSTRAP_ADMIN_PASSWORD",
    "BOOTSTRAP_ADMIN_ROLE",
  ]) {
    delete environment[name];
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete environment[name];
    } else {
      environment[name] = value;
    }
  }
  return environment;
}

async function runCli(
  environment: NodeJS.ProcessEnv,
  extraArgs: string[] = [],
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [tsxCliPath, bootstrapScriptPath, ...extraArgs],
      {
        cwd: backendRoot,
        env: environment,
        timeout: 60_000,
        windowsHide: true,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

/** Legitimate client DI: only the audit delegate is intercepted in this test. */
function auditFailingClient(base: PrismaClient): PrismaClient {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        const transaction = target.$transaction.bind(target) as (
          callback: (tx: unknown) => Promise<unknown>,
          options?: unknown,
        ) => Promise<unknown>;

        return async (callback: (tx: unknown) => Promise<unknown>, options?: unknown) =>
          transaction(async (tx) => {
            const guardedTx = new Proxy(tx as object, {
              get(txTarget, txProperty, txReceiver) {
                if (txProperty === "auditEvent") {
                  const delegate = Reflect.get(txTarget, txProperty, txReceiver) as Record<string, unknown>;
                  return new Proxy(delegate, {
                    get(delegateTarget, delegateProperty, delegateReceiver) {
                      if (delegateProperty === "create") {
                        return async () => {
                          throw new Error("simulated audit write failure");
                        };
                      }
                      const value = Reflect.get(delegateTarget, delegateProperty, delegateReceiver);
                      return typeof value === "function" ? value.bind(delegateTarget) : value;
                    },
                  });
                }
                const value = Reflect.get(txTarget, txProperty, txReceiver);
                return typeof value === "function" ? value.bind(txTarget) : value;
              },
            });
            return callback(guardedTx);
          }, options);
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

describe("bootstrapAdmin against PostgreSQL", () => {
  it("creates the first admin with bcrypt cost 12, normalized data and one SYSTEM audit", async () => {
    const result = await bootstrapAdmin(prisma, {
      email: `  ${EMAIL.toUpperCase()}  `,
      fullName: `  ${FULL_NAME}  `,
      password: PASSWORD,
    });

    expect(result.role).toBe("ADMIN");
    expect(result).not.toHaveProperty("email");
    expect(result).not.toHaveProperty("passwordHash");

    const user = await prisma.user.findUniqueOrThrow({ where: { id: result.id } });
    expect(user.email).toBe(EMAIL);
    expect(user.fullName).toBe(FULL_NAME);
    expect(user.role).toBe("ADMIN");
    expect(user.isActive).toBe(true);
    expect(user.passwordHash).not.toBe(PASSWORD);
    expect(await bcrypt.compare(PASSWORD, user.passwordHash)).toBe(true);
    expect(bcrypt.getRounds(user.passwordHash)).toBe(BOOTSTRAP_BCRYPT_COST);

    const audits = await prisma.auditEvent.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorKind: "SYSTEM",
      actorUserId: null,
      targetType: "USER",
      targetUserId: result.id,
      targetId: null,
      action: "ADMIN_BOOTSTRAP",
      outcome: "SUCCESS",
      metadata: { channel: "bootstrap-cli" },
    });
    expect(JSON.stringify(audits[0])).not.toContain(EMAIL);
    expect(JSON.stringify(audits[0])).not.toContain(PASSWORD);
  });

  it("rejects a second bootstrap even when the existing admin is inactive, with no writes", async () => {
    const first = await bootstrapAdmin(prisma, {
      email: EMAIL,
      fullName: FULL_NAME,
      password: PASSWORD,
    });
    await prisma.user.update({ where: { id: first.id }, data: { isActive: false } });

    const usersBefore = await prisma.user.count();
    const auditsBefore = await prisma.auditEvent.count();
    await expect(
      bootstrapAdmin(prisma, {
        email: "second-admin@clearsight.test",
        fullName: "Second Admin",
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_ALREADY_INITIALIZED" });

    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.auditEvent.count()).toBe(auditsBefore);
  });

  it("rejects a case-insensitive email owned by a non-admin without promoting it", async () => {
    const existing = await prisma.user.create({
      data: {
        email: "doctor@clearsight.test",
        passwordHash: "x",
        fullName: "Existing Doctor",
        role: "OFTALMOLOGO",
      },
    });

    await expect(
      bootstrapAdmin(prisma, {
        email: "DOCTOR@CLEARSIGHT.TEST",
        fullName: "New Admin",
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_EMAIL_CONFLICT" });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after.role).toBe("OFTALMOLOGO");
    expect(after.fullName).toBe("Existing Doctor");
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("serializes concurrent bootstraps into exactly one admin and one audit", async () => {
    const results = await Promise.allSettled([
      bootstrapAdmin(prisma, {
        email: "concurrent-a@clearsight.test",
        fullName: "Concurrent A",
        password: PASSWORD,
      }),
      bootstrapAdmin(prisma, {
        email: "concurrent-b@clearsight.test",
        fullName: "Concurrent B",
        password: PASSWORD,
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeDefined();
    const reason = (rejected[0] as PromiseRejectedResult).reason as unknown;
    expect(reason).toBeInstanceOf(BootstrapAdminError);
    expect((reason as BootstrapAdminError).code).toBe("BOOTSTRAP_ALREADY_INITIALIZED");

    expect(await prisma.user.count({ where: { role: "ADMIN" } })).toBe(1);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.auditEvent.count()).toBe(1);
  });

  it("rolls back the admin when the audit insert fails", async () => {
    const failing = auditFailingClient(prisma);
    await expect(
      bootstrapAdmin(failing, {
        email: EMAIL,
        fullName: FULL_NAME,
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({
      code: "BOOTSTRAP_AUDIT_FAILED",
      message: "the bootstrap audit record could not be written",
    });

    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });
});

describe("admin:bootstrap CLI", () => {
  it("creates the first admin against the owned database without printing secrets", async () => {
    const url = ownedDatabaseUrl();
    const run = await runCli(
      childEnvironment({
        MIGRATION_DATABASE_URL: url,
        DATABASE_URL: url,
        BOOTSTRAP_ADMIN_EMAIL: EMAIL,
        BOOTSTRAP_ADMIN_FULL_NAME: FULL_NAME,
        BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
        // The CLI does not read a role variable; ADMIN is server-selected.
        BOOTSTRAP_ADMIN_ROLE: "OFTALMOLOGO",
      }),
    );

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/\[bootstrap\] ok userId=[0-9a-f-]+ role=ADMIN/);
    expect(run.stderr).not.toMatch(/injected env/i);
    for (const secret of [EMAIL, PASSWORD, FULL_NAME, url]) {
      expect(run.stdout).not.toContain(secret);
      expect(run.stderr).not.toContain(secret);
    }

    const admin = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
    expect(admin.email).toBe(EMAIL);
    expect(admin.fullName).toBe(FULL_NAME);
    expect(admin.isActive).toBe(true);
    expect(await prisma.auditEvent.count()).toBe(1);
  });

  it("fails safely before any connection when the database configuration is missing", async () => {
    const canaryEmail = "canary-cli-email@clearsight.test";
    const canaryPassword = "canary-cli-password-123";
    const run = await runCli(
      childEnvironment({
        BOOTSTRAP_ADMIN_EMAIL: canaryEmail,
        BOOTSTRAP_ADMIN_FULL_NAME: FULL_NAME,
        BOOTSTRAP_ADMIN_PASSWORD: canaryPassword,
      }),
    );

    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("BOOTSTRAP_CONFIG_INVALID");
    expect(run.stderr).not.toContain(canaryEmail);
    expect(run.stderr).not.toContain(canaryPassword);
    expect(await prisma.user.count()).toBe(0);
  });

  it("fails safely before any connection when the input is invalid", async () => {
    const url = ownedDatabaseUrl();
    const canaryEmail = "canary-invalid@clearsight.test";
    const canaryPassword = "short";
    const run = await runCli(
      childEnvironment({
        MIGRATION_DATABASE_URL: url,
        DATABASE_URL: url,
        BOOTSTRAP_ADMIN_EMAIL: canaryEmail,
        BOOTSTRAP_ADMIN_FULL_NAME: "",
        BOOTSTRAP_ADMIN_PASSWORD: canaryPassword,
      }),
    );

    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("BOOTSTRAP_INPUT_INVALID");
    expect(run.stderr).not.toContain(canaryEmail);
    expect(run.stderr).not.toContain(canaryPassword);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("reports a committed bootstrap with cleanup=PENDING and exit 2 when disconnect throws", async () => {
    const url = ownedDatabaseUrl();
    const environment = childEnvironment({
      MIGRATION_DATABASE_URL: url,
      DATABASE_URL: url,
      BOOTSTRAP_ADMIN_EMAIL: EMAIL,
      BOOTSTRAP_ADMIN_FULL_NAME: FULL_NAME,
      BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
    });
    const out: string[] = [];
    const err: string[] = [];
    const writers: BootstrapCliWriters = {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    };

    const client = createTestPrisma();
    const originalDisconnect = client.$disconnect.bind(client);
    const canary = "postgresql://CanarySecret:canary-password@canary-host/clearsight";
    const disconnectSpy = vi.spyOn(client, "$disconnect").mockImplementation(async () => {
      await originalDisconnect();
      throw new Error(canary);
    });
    let factoryTargetUrl: string | undefined;
    const factory: BootstrapClientFactory = (target) => {
      factoryTargetUrl = target.url;
      return client;
    };

    let exitCode = -1;
    try {
      exitCode = await runBootstrapAdminCli(environment, writers, factory);
    } finally {
      disconnectSpy.mockRestore();
      await originalDisconnect().catch(() => undefined);
    }

    expect(exitCode).toBe(2);
    expect(factoryTargetUrl).toBe(url);
    expect(out).toHaveLength(1);
    const receipt = out[0]!;
    const receiptMatch = receipt.match(
      /^\[bootstrap\] ok userId=([0-9a-f-]{36}) role=ADMIN operationStatus=COMMITTED cleanup=PENDING$/,
    );
    expect(receiptMatch).not.toBeNull();
    const committedAdminId = receiptMatch![1]!;
    expect(receipt).toMatch(/\[bootstrap\] ok userId=[0-9a-f-]+ role=ADMIN/);
    expect(out.join("\n")).not.toMatch(/failed|rolled back|rollback/i);
    expect(err).toEqual([
      "[bootstrap] warning code=BOOTSTRAP_DISCONNECT_FAILED message=the bootstrap database connection could not be closed",
    ]);
    for (const text of [out.join("\n"), err.join("\n")]) {
      expect(text).not.toContain("CanarySecret");
      expect(text).not.toContain("canary-password");
      expect(text).not.toContain("canary-host");
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(EMAIL);
    }

    const admins = await prisma.user.findMany({ where: { role: "ADMIN" } });
    expect(admins).toHaveLength(1);
    expect(admins[0]!.id).toBe(committedAdminId);
    const audits = await prisma.auditEvent.findMany({ where: { action: "ADMIN_BOOTSTRAP" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorKind: "SYSTEM",
      targetType: "USER",
      targetUserId: committedAdminId,
      outcome: "SUCCESS",
    });
  });
});

describe("POST /auth/register retirement", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(fastifyJwt, { secret: "test-jwt-secret-test-jwt-secret-1234" });
    await app.register(authRoutes, { prefix: "/auth" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { email: "public-attacker@clearsight.test", password: "synthetic-password", role: "ADMIN" },
    { email: "public-attacker@clearsight.test", password: "synthetic-password", role: "INVESTIGADOR" },
    { role: "ADMIN" },
    { anything: true },
    {},
  ])("returns 410 for any valid JSON shape without DB, token or audit effects: %j", async (payload) => {
    const findUnique = vi.spyOn(singletonPrisma.user, "findUnique");
    const create = vi.spyOn(singletonPrisma.user, "create");
    const sign = vi.spyOn(app.jwt, "sign");
    const hash = vi.spyOn(bcrypt, "hash");
    const usersBefore = await prisma.user.count();
    const auditsBefore = await prisma.auditEvent.count();

    const response = await app.inject({ method: "POST", url: "/auth/register", payload });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({
      error: "Gone",
      message: "Public registration has been retired",
      statusCode: 410,
    });
    expect(response.body).not.toContain("accessToken");
    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.auditEvent.count()).toBe(auditsBefore);
  });

  it("returns 410 for an authenticated ADMIN caller and never emits a new token", async () => {
    const token = app.jwt.sign({
      sub: "99999999-9999-4999-8999-999999999999",
      role: "ADMIN",
    });
    const sign = vi.spyOn(app.jwt, "sign");
    const usersBefore = await prisma.user.count();

    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      headers: { authorization: `Bearer ${token}` },
      payload: { email: "authenticated-admin@clearsight.test", role: "ADMIN" },
    });

    expect(response.statusCode).toBe(410);
    expect(response.body).not.toContain("accessToken");
    expect(sign).not.toHaveBeenCalled();
    expect(await prisma.user.count()).toBe(usersBefore);
  });

  it("lets the transport parser return 400 for malformed JSON without an account change", async () => {
    const usersBefore = await prisma.user.count();
    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });

    expect(response.statusCode).toBe(400);
    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.auditEvent.count()).toBe(0);
  });
});

describe("QA adversarial: CLI hardening (task 1.6)", () => {
  it("ignores --password/--role argv and never echoes the argv canary", async () => {
    const url = ownedDatabaseUrl();
    const canaryArg = "canary-argv-secret-98765";
    const run = await runCli(
      childEnvironment({
        MIGRATION_DATABASE_URL: url,
        DATABASE_URL: url,
        BOOTSTRAP_ADMIN_EMAIL: EMAIL,
        BOOTSTRAP_ADMIN_FULL_NAME: FULL_NAME,
        BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
      }),
      [`--password=${canaryArg}`, `--role=OFTALMOLOGO`, `--email=canary-argv-email@clearsight.test`],
    );

    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain(canaryArg);
    expect(run.stderr).not.toContain(canaryArg);
    expect(run.stdout).not.toContain("canary-argv-email");
    expect(run.stderr).not.toContain("canary-argv-email");

    const admin = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
    expect(admin.email).toBe(EMAIL);
    expect(admin.role).toBe("ADMIN");
    expect(admin.isActive).toBe(true);
    expect(await prisma.auditEvent.count()).toBe(1);
  });

  it("does not accept an argv password when the env password is missing", async () => {
    const url = ownedDatabaseUrl();
    const canaryArg = "canary-argv-secret-12345";
    const run = await runCli(
      childEnvironment({
        MIGRATION_DATABASE_URL: url,
        BOOTSTRAP_ADMIN_EMAIL: EMAIL,
        BOOTSTRAP_ADMIN_FULL_NAME: FULL_NAME,
      }),
      [`--password=${canaryArg}`],
    );

    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("BOOTSTRAP_INPUT_INVALID");
    expect(run.stderr).not.toContain(canaryArg);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });
});

describe("QA adversarial: bootstrap semantics (task 1.6)", () => {
  it("verdicts ALREADY_INITIALIZED before the email conflict when both conditions hold", async () => {
    await prisma.user.create({
      data: {
        email: "qa-precedence-admin@clearsight.test",
        passwordHash: "x",
        fullName: "Precedence Admin",
        role: "ADMIN",
      },
    });
    const ordinary = await prisma.user.create({
      data: {
        email: "qa-precedence-doctor@clearsight.test",
        passwordHash: "x",
        fullName: "Precedence Doctor",
        role: "OFTALMOLOGO",
      },
    });

    await expect(
      bootstrapAdmin(prisma, {
        email: "QA-PRECEDENCE-DOCTOR@CLEARSIGHT.TEST",
        fullName: "Should Not Be Created",
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_ALREADY_INITIALIZED" });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: ordinary.id } });
    expect(after.role).toBe("OFTALMOLOGO");
    expect(await prisma.user.count()).toBe(2);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("serializes same-email concurrent bootstraps into one admin and one audit", async () => {
    const results = await Promise.allSettled([
      bootstrapAdmin(prisma, {
        email: "qa-race-same@clearsight.test",
        fullName: "Race Same A",
        password: PASSWORD,
      }),
      bootstrapAdmin(prisma, {
        email: "QA-RACE-SAME@CLEARSIGHT.TEST",
        fullName: "Race Same B",
        password: PASSWORD,
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as BootstrapAdminError;
    // The admin-existence check runs first under the lifecycle lock, so the
    // loser deterministically reports ALREADY_INITIALIZED (never a raw P2002).
    expect(reason).toBeInstanceOf(BootstrapAdminError);
    expect(reason.code).toBe("BOOTSTRAP_ALREADY_INITIALIZED");

    expect(await prisma.user.count({ where: { role: "ADMIN" } })).toBe(1);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.auditEvent.count()).toBe(1);
  });

  it("blocks the whole bootstrap transaction on the global lifecycle lock", async () => {
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolveGate) => {
      releaseHolder = resolveGate;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolveLocked) => {
      signalLocked = resolveLocked;
    });

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe<Array<{ locked: number }>>(
          "SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS acquired",
          ADMIN_LIFECYCLE_LOCK_KEY,
        );
        signalLocked();
        await holderGate;
      },
      { timeout: 20_000, maxWait: 5_000 },
    );

    await locked;
    const boot = bootstrapAdmin(prisma, {
      email: EMAIL,
      fullName: FULL_NAME,
      password: PASSWORD,
    });
    boot.catch(() => undefined);

    const settledEarly = await Promise.race([
      boot.then(() => true, () => true),
      new Promise<boolean>((resolveRace) => setTimeout(() => resolveRace(false), 400)),
    ]);
    expect(settledEarly).toBe(false);

    releaseHolder();
    await holder;
    const result = await boot;
    expect(result.role).toBe("ADMIN");
    expect(await prisma.user.count({ where: { role: "ADMIN" } })).toBe(1);
    expect(await prisma.auditEvent.count()).toBe(1);
  });

  it("routes the bootstrap to the MIGRATION_DATABASE_URL schema and never to DATABASE_URL", async () => {
    const url = ownedDatabaseUrl();
    const altSchema = "qa_bootstrap_alt";
    const client = new Client({ connectionString: url });
    await client.connect();

    try {
      await client.query(`CREATE SCHEMA ${altSchema}`);
      await client.query(`SET search_path TO ${altSchema}`);
      await applyMigrations(client);

      const withSchema = (rawUrl: string, schema: string): string => {
        const parsed = new URL(rawUrl);
        parsed.searchParams.set("schema", schema);
        return parsed.toString();
      };

      const run = await runCli(
        childEnvironment({
          MIGRATION_DATABASE_URL: withSchema(url, altSchema),
          DATABASE_URL: withSchema(url, "public"),
          BOOTSTRAP_ADMIN_EMAIL: EMAIL,
          BOOTSTRAP_ADMIN_FULL_NAME: FULL_NAME,
          BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
        }),
      );

      expect(run.code).toBe(0);
      expect(run.stdout).toMatch(/\[bootstrap\] ok userId=[0-9a-f-]+ role=ADMIN/);
      expect(run.stdout).not.toContain(url);
      expect(run.stderr).not.toContain(url);

      const altUsers = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${altSchema}.users WHERE role = 'ADMIN'`,
      );
      expect(altUsers.rows[0]?.n).toBe(1);
      const altAudits = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${altSchema}.audit_events WHERE action = 'ADMIN_BOOTSTRAP'`,
      );
      expect(altAudits.rows[0]?.n).toBe(1);
      const publicUsers = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM public.users");
      expect(publicUsers.rows[0]?.n).toBe(0);
      const publicAudits = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.audit_events",
      );
      expect(publicAudits.rows[0]?.n).toBe(0);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${altSchema} CASCADE`);
      await client.end();
    }
  });
});

describe("QA adversarial: register body shapes (task 1.6)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(fastifyJwt, { secret: "test-jwt-secret-test-jwt-secret-1234" });
    await app.register(authRoutes, { prefix: "/auth" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { label: "JSON array", raw: "[1,2,3]" },
    { label: "JSON string", raw: '"just-a-string"' },
    { label: "JSON number", raw: "42" },
    { label: "JSON null", raw: "null" },
    {
      label: "legacy REG-005 shape with DOCTOR role",
      raw: JSON.stringify({
        email: "qa-doctor@clearsight.test",
        password: "password123",
        fullName: "QA Doctor",
        role: "DOCTOR",
      }),
    },
    {
      label: "legacy REG-005 shape with RESEARCHER role",
      raw: JSON.stringify({
        email: "qa-researcher@clearsight.test",
        password: "password123",
        fullName: "QA Researcher",
        role: "RESEARCHER",
      }),
    },
    {
      label: "nested ADMIN escalation attempt",
      raw: JSON.stringify({ data: { role: "ADMIN" }, user: { role: "ADMIN", isActive: true } }),
    },
  ])("returns 410 and touches nothing for $label", async ({ raw }) => {
    const findUnique = vi.spyOn(singletonPrisma.user, "findUnique");
    const findFirst = vi.spyOn(singletonPrisma.user, "findFirst");
    const create = vi.spyOn(singletonPrisma.user, "create");
    const sign = vi.spyOn(app.jwt, "sign");
    const hash = vi.spyOn(bcrypt, "hash");
    const usersBefore = await prisma.user.count();
    const auditsBefore = await prisma.auditEvent.count();

    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      headers: { "content-type": "application/json" },
      payload: raw,
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({
      error: "Gone",
      message: "Public registration has been retired",
      statusCode: 410,
    });
    expect(findUnique).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.auditEvent.count()).toBe(auditsBefore);
  });

  it.each([{ raw: '{"email":' }, { raw: '{"role": "ADMIN", ' }, { raw: "ADMIN" }])(
    "returns 400 from the transport parser for malformed JSON $raw without touching state",
    async ({ raw }) => {
      const usersBefore = await prisma.user.count();
      const response = await app.inject({
        method: "POST",
        url: "/auth/register",
        headers: { "content-type": "application/json" },
        payload: raw,
      });

      expect(response.statusCode).toBe(400);
      expect(await prisma.user.count()).toBe(usersBefore);
      expect(await prisma.auditEvent.count()).toBe(0);
    },
  );
});
