import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { describe, expect, it } from "vitest";
import { badRequest } from "../../src/lib/http-error.js";
import {
  AUTH_LOG_REDACT_PATHS,
  buildLoggerOptions,
  LOG_REDACTION_CENSOR,
} from "../../src/lib/log-redaction.js";
import { registerGenericNotFoundHandler } from "../../src/lib/not-found-handler.js";
import {
  ArtifactType,
  ArtifactUrlQuerySchema,
} from "../../src/schemas/inference.js";

interface Capture {
  stream: Writable;
  lines: string[];
  text: () => string;
}

function createCapture(): Capture {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { stream, lines, text: () => lines.join("") };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function buildProbeApp(
  capture: Capture,
  options: FastifyServerOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger: buildLoggerOptions(capture.stream),
    ...options,
  });
  // The same production installer used by app.ts; tests must not mirror it.
  registerGenericNotFoundHandler(app);
  return app;
}

function parsed(capture: Capture): Array<Record<string, any>> {
  return capture.lines
    .join("")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

const NOT_FOUND_CANARY_SIG = "CANARY_404_SIG";
const NOT_FOUND_CANARY_TOKEN = "CANARY_404_TOKEN";

async function expectGenericNotFound(
  capture: Capture,
  app: FastifyInstance,
  request: { method: "GET" | "POST"; url: string },
): Promise<void> {
  const response = await app.inject(request);
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({
    message: "Route not found",
    error: "Not Found",
    statusCode: 404,
  });
  expect(response.body).not.toContain(NOT_FOUND_CANARY_SIG);
  expect(response.body).not.toContain(NOT_FOUND_CANARY_TOKEN);
  await flush();

  const output = capture.text();
  for (const leak of [
    NOT_FOUND_CANARY_SIG,
    NOT_FOUND_CANARY_TOKEN,
    "X-Amz-Signature",
    "secret.example",
  ]) {
    expect(output).not.toContain(leak);
  }
  expect(output).not.toMatch(/Route (GET|POST):\//);

  const entries = parsed(capture);
  const incoming = entries.find((entry) => entry.msg === "incoming request");
  const completed = entries.find((entry) => entry.msg === "request completed");
  expect(incoming).toMatchObject({
    req: { method: request.method, url: LOG_REDACTION_CENSOR },
  });
  expect(typeof incoming?.reqId).toBe("string");
  expect(completed).toMatchObject({
    reqId: incoming?.reqId,
    res: { statusCode: 404 },
  });
}

async function probeNotFound(request: {
  method: "GET" | "POST";
  url: string;
}): Promise<void> {
  const capture = createCapture();
  const app = buildProbeApp(capture);
  app.get("/probe", async () => ({ ok: true }));
  await app.ready();
  try {
    await expectGenericNotFound(capture, app, request);
  } finally {
    await app.close();
  }
}

describe("credential log redaction", () => {
  it("censors the whole request URL but keeps reqId, method and response status", async () => {
    const capture = createCapture();
    const app = buildProbeApp(capture);
    app.get("/probe", async () => ({ ok: true }));
    await app.ready();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/probe?version=1&X-Amz-Signature=CANARY_SIG&token=CANARY_TOKEN&encoded=https%3A%2F%2Fsecret.example%2Fobject%3Fsig%3DCANARY_SIG",
        headers: {
          authorization: "Bearer CANARY_BEARER",
          cookie: "refresh=CANARY_COOKIE",
        },
      });
      expect(response.statusCode).toBe(200);
      await flush();

      const output = capture.text();
      for (const leak of [
        "CANARY_SIG",
        "CANARY_TOKEN",
        "CANARY_BEARER",
        "CANARY_COOKIE",
        "X-Amz-Signature",
        "secret.example",
        "version=1",
      ]) {
        expect(output).not.toContain(leak);
      }
      expect(output).toContain(`"url":"${LOG_REDACTION_CENSOR}"`);

      const entries = parsed(capture);
      const incoming = entries.find((entry) => entry.msg === "incoming request");
      const completed = entries.find((entry) => entry.msg === "request completed");
      expect(incoming).toMatchObject({
        req: { method: "GET", url: LOG_REDACTION_CENSOR },
      });
      expect(typeof incoming?.reqId).toBe("string");
      expect(incoming?.reqId.length).toBeGreaterThan(0);
      expect(completed).toMatchObject({
        reqId: incoming?.reqId,
        res: { statusCode: 200 },
      });
    } finally {
      await app.close();
    }
  });

  it("censors header casing variants when a serializer exposes raw headers", async () => {
    const capture = createCapture();
    const app = buildProbeApp(capture, {
      logController: new Fastify.LogController({ disableRequestLogging: true }),
    });
    app.get(
      "/headers",
      {
        logSerializers: {
          req: (value: unknown) => value,
          res: (value: unknown) => value,
        },
      },
      async (request) => {
        request.log.info(
          {
            req: {
              headers: {
                Authorization: "Bearer CANARY_BEARER_UPPER",
                Cookie: "refresh=CANARY_COOKIE_UPPER",
                "Proxy-Authorization": "Basic CANARY_PROXY_UPPER",
              },
            },
            res: {
              headers: {
                "Set-Cookie": "refresh=CANARY_SET_COOKIE_UPPER",
                "set-cookie": "refresh=CANARY_SET_COOKIE_LOWER",
              },
            },
          },
          "sensitive headers",
        );
        return { ok: true };
      },
    );
    await app.ready();

    try {
      await app.inject({ method: "GET", url: "/headers" });
      await flush();

      const output = capture.text();
      for (const leak of [
        "CANARY_BEARER_UPPER",
        "CANARY_COOKIE_UPPER",
        "CANARY_PROXY_UPPER",
        "CANARY_SET_COOKIE_UPPER",
        "CANARY_SET_COOKIE_LOWER",
      ]) {
        expect(output).not.toContain(leak);
      }
      expect(output).toContain(LOG_REDACTION_CENSOR);
    } finally {
      await app.close();
    }
  });

  it("censors a structured req.query even when a serializer exposes it", async () => {
    const capture = createCapture();
    const app = buildProbeApp(capture, {
      logController: new Fastify.LogController({ disableRequestLogging: true }),
    });
    app.get(
      "/structured",
      {
        logSerializers: {
          req: (value: unknown) => value,
        },
      },
      async (request) => {
        request.log.info(
          {
            req: {
              method: request.method,
              url: "/structured",
              query: request.query,
            },
          },
          "structured request",
        );
        return { ok: true };
      },
    );
    await app.ready();

    try {
      await app.inject({
        method: "GET",
        url: "/structured?token=CANARY_QUERY_TOKEN&X-Amz-Signature=CANARY_QUERY_SIG",
      });
      await flush();

      const output = capture.text();
      expect(output).not.toContain("CANARY_QUERY_TOKEN");
      expect(output).not.toContain("CANARY_QUERY_SIG");
      expect(output).not.toContain("X-Amz-Signature");
      expect(output).toContain(`"query":"${LOG_REDACTION_CENSOR}"`);
    } finally {
      await app.close();
    }
  });

  it("keeps the credential body and request header paths configured", () => {
    const paths = new Set(AUTH_LOG_REDACT_PATHS);
    expect(paths.has("req.headers.authorization")).toBe(true);
    expect(paths.has("req.headers.Authorization")).toBe(true);
    expect(paths.has("req.headers.cookie")).toBe(true);
    expect(paths.has("req.headers.Cookie")).toBe(true);
    expect(paths.has('req.headers["proxy-authorization"]')).toBe(true);
    expect(paths.has('req.headers["Proxy-Authorization"]')).toBe(true);
    expect(paths.has('req.headers["Set-Cookie"]')).toBe(true);
    expect(paths.has('res.headers["set-cookie"]')).toBe(true);
    expect(paths.has('res.headers["Set-Cookie"]')).toBe(true);
    expect(paths.has("req.body.password")).toBe(true);
    expect(paths.has("req.body.refreshToken")).toBe(true);
    expect(paths.has("req.body.newPassword")).toBe(true);
    expect(paths.has("req.body.token")).toBe(true);
    expect(paths.has("req.body.email")).toBe(true);
  });
});

describe("not-found log redaction", () => {
  it("does not echo or log an unknown artifact path", async () => {
    await probeNotFound({
      method: "GET",
      url: `/inferences/${randomUUID()}/artifacts/unknown?X-Amz-Signature=${NOT_FOUND_CANARY_SIG}&token=${NOT_FOUND_CANARY_TOKEN}&encoded=https%3A%2F%2Fsecret.example`,
    });
  });

  it("does not echo or log a malformed artifact path", async () => {
    await probeNotFound({
      method: "GET",
      url: `/inferences/not-a-uuid/artifacts/mask/url/extra?X-Amz-Signature=${NOT_FOUND_CANARY_SIG}&token=${NOT_FOUND_CANARY_TOKEN}`,
    });
  });

  it("does not echo or log an unsupported method", async () => {
    await probeNotFound({
      method: "POST",
      url: `/inferences/${randomUUID()}/artifacts/mask/url?version=1&X-Amz-Signature=${NOT_FOUND_CANARY_SIG}&token=${NOT_FOUND_CANARY_TOKEN}&encoded=https%3A%2F%2Fsecret.example`,
    });
  });
});

/**
 * Gap HITO23/3.7: the autogenerated framework logs on failure paths. Pino
 * redact.paths censors fields but cannot censor a message string; stock
 * Fastify interpolates `request.raw.url` into the "route not found" log
 * message (lib/log-controller.js routeNotFound). These probes pin that no
 * autogenerated log line carries the raw URL, query or canaries, while the
 * reqId/method/status correlation is retained.
 */
describe("autogenerated framework logs on artifact-path failures", () => {
  const CANARY_Q =
    "?X-Amz-Signature=CANARY_SIG&token=CANARY_TOKEN&encoded=https%3A%2F%2Fsecret.example%2Fobject%3Fsig%3DCANARY_ENC";
  const LEAKS = [
    "CANARY_SIG",
    "CANARY_TOKEN",
    "CANARY_ENC",
    "CANARY_BEARER",
    "X-Amz-Signature",
    "secret.example",
    "/artifacts",
  ];

  function buildArtifactProbe(capture: Capture): FastifyInstance {
    const app = buildProbeApp(capture);
    // Mirrors routes/artifacts.ts: parseArtifactType then parseUrlQuery with
    // the real strict schema, auth seam first.
    app.get("/inferences/:id/artifacts/:type/url", async (request, reply) => {
      if (request.headers.authorization === undefined) {
        reply.code(401);
        return { error: "unauthorized" };
      }
      const type = ArtifactType.safeParse(
        (request.params as { type: string }).type,
      );
      if (!type.success) {
        throw badRequest("Unsupported artifact type");
      }
      const query = ArtifactUrlQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw badRequest("A positive artifact version is required");
      }
      return { url: "https://signed.example/object" };
    });
    return app;
  }

  function expectNoUrlLeak(capture: Capture): void {
    const output = capture.text();
    for (const leak of LEAKS) {
      expect(output).not.toContain(leak);
    }
  }

  function expectCorrelation(
    capture: Capture,
    method: string,
    statusCode: number,
  ): void {
    const entries = parsed(capture);
    const incoming = entries.find((entry) => entry.msg === "incoming request");
    expect(incoming).toMatchObject({
      req: { method, url: LOG_REDACTION_CENSOR },
    });
    expect(typeof incoming?.reqId).toBe("string");
    expect(incoming?.reqId.length).toBeGreaterThan(0);
    expect(
      entries.find((entry) => entry.msg === "request completed"),
    ).toMatchObject({
      reqId: incoming?.reqId,
      res: { statusCode },
    });
  }

  it("keeps unknown artifact paths (404) out of the autogenerated logs", async () => {
    const capture = createCapture();
    const app = buildArtifactProbe(capture);
    await app.ready();

    try {
      const response = await app.inject({
        method: "GET",
        url: `/inferences/11111111-1111-1111-1111-111111111111/artifacts/mask/unknown-action${CANARY_Q}`,
      });
      expect(response.statusCode).toBe(404);
      await flush();

      expectNoUrlLeak(capture);
      expectCorrelation(capture, "GET", 404);
    } finally {
      await app.close();
    }
  });

  it("keeps malformed artifact paths (404) out of the autogenerated logs", async () => {
    const capture = createCapture();
    const app = buildArtifactProbe(capture);
    await app.ready();

    try {
      const response = await app.inject({
        method: "GET",
        url: `/inferences/11111111-1111-1111-1111-111111111111/artifacts/mask${CANARY_Q}`,
      });
      expect(response.statusCode).toBe(404);
      await flush();

      expectNoUrlLeak(capture);
      expectCorrelation(capture, "GET", 404);
    } finally {
      await app.close();
    }
  });

  it("keeps percent-malformed artifact URLs (400) out of the logs", async () => {
    const capture = createCapture();
    const app = buildArtifactProbe(capture);
    await app.ready();

    try {
      const response = await app.inject({
        method: "GET",
        url: `/inferences/%zz/artifacts/mask/url${CANARY_Q}`,
      });
      expect(response.statusCode).toBe(400);
      await flush();

      expectNoUrlLeak(capture);
    } finally {
      await app.close();
    }
  });

  it("keeps wrong-method download requests out of the autogenerated logs", async () => {
    const capture = createCapture();
    const app = buildArtifactProbe(capture);
    await app.ready();

    try {
      // Fastify resolves a method mismatch through the not-found handler
      // (fastify/fastify#862): 404 on the wire, same routeNotFound log path.
      const response = await app.inject({
        method: "POST",
        url: `/inferences/11111111-1111-1111-1111-111111111111/artifacts/mask/url${CANARY_Q}`,
      });
      expect(response.statusCode).toBe(404);
      await flush();

      expectNoUrlLeak(capture);
      expectCorrelation(capture, "POST", 404);
    } finally {
      await app.close();
    }
  });

  it("keeps unauthorized valid-path requests (401) out of the autogenerated logs", async () => {
    const capture = createCapture();
    const app = buildArtifactProbe(capture);
    await app.ready();

    try {
      const response = await app.inject({
        method: "GET",
        url: `/inferences/11111111-1111-1111-1111-111111111111/artifacts/mask/url${CANARY_Q}`,
      });
      expect(response.statusCode).toBe(401);
      await flush();

      expectNoUrlLeak(capture);
      expectCorrelation(capture, "GET", 401);
    } finally {
      await app.close();
    }
  });

  it("keeps schema-invalid requests (400) out of the autogenerated logs", async () => {
    const capture = createCapture();
    const app = buildArtifactProbe(capture);
    await app.ready();

    try {
      // Hostile query keys fail the strict query schema in the handler.
      const hostileQuery = await app.inject({
        method: "GET",
        url: `/inferences/11111111-1111-1111-1111-111111111111/artifacts/mask/url${CANARY_Q}`,
        headers: { authorization: "Bearer CANARY_BEARER" },
      });
      expect(hostileQuery.statusCode).toBe(400);
      await flush();
      expectNoUrlLeak(capture);
      expectCorrelation(capture, "GET", 400);

      capture.lines.length = 0;
      const badType = await app.inject({
        method: "GET",
        url: "/inferences/11111111-1111-1111-1111-111111111111/artifacts/bogus/url?version=1",
        headers: { authorization: "Bearer CANARY_BEARER" },
      });
      expect(badType.statusCode).toBe(400);
      await flush();
      expectNoUrlLeak(capture);
      expectCorrelation(capture, "GET", 400);
    } finally {
      await app.close();
    }
  });
});
