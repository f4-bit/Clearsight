const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

function reply(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

function makeReport() {
  const content = "BT /F1 14 Tf 30 75 Td (ClearSight smoke-test report) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream",
  ];
  let document = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = document.length;
    document += (index + 1) + " 0 obj\n" + object + "\nendobj\n";
    return offset;
  });
  const xref = document.length;
  document += "xref\n0 6\n0000000000 65535 f \n";
  for (const offset of offsets) document += String(offset).padStart(10, "0") + " 00000 n \n";
  return Buffer.from(document + "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
}

function createClinicalFixture() {
  const user = { id: randomUUID(), email: "smoke@example.invalid", role: "OFTALMOLOGO" };
  const researcher = { id: randomUUID(), email: "research@example.invalid", role: "INVESTIGADOR" };
  const admin = { id: randomUUID(), email: "admin@example.invalid", role: "ADMIN" };
  const password = "fixture-password-only";
  const patientId = randomUUID();
  const consultationId = randomUUID();
  const inferenceId = randomUUID();
  const imageId = randomUUID();
  const createdAt = new Date().toISOString();
  const accounts = [user, researcher, admin].map((account, index) => ({
    ...account, fullName: ["Oftalmología de prueba", "Investigación de prueba", "Administración de prueba"][index],
    isActive: true, createdAt, updatedAt: createdAt,
  }));
  const pdf = makeReport();
  const errors = [];
  let token, cookie, sessionUser, clinical, image, intent, feedback;
  let reads = 0;
  let attempts = 0;
  let consultations = 0;
  let uploads = 0;
  let refreshes = 0;
  let frozen = false;
  let holdAnalysis = false;
  let images, webOrigin, apiOrigin;

  function issueSession(response, includeUser) {
    token = randomUUID();
    cookie = randomUUID();
    reply(response, 200, { accessToken: token, ...(includeUser ? { user: sessionUser } : {}) }, {
      "Set-Cookie": "clearsight_refresh=" + cookie + "; Path=/api/auth; HttpOnly; Secure; SameSite=Lax",
    });
  }

  async function handle(request, response) {
    const url = new URL(request.url, apiOrigin);
    const route = request.method + " " + url.pathname;
    if (route === "GET /overlay.png" || route === "GET /mask.png") {
      response.writeHead(200, { "Content-Type": "image/png" });
      return response.end(route === "GET /mask.png" ? images.mask : images.overlay);
    }
    if (route === "GET /fixture.pdf") {
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="clearsight-smoke.pdf"',
      });
      return response.end(pdf);
    }

    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const json = () => JSON.parse(bytes.toString("utf8"));

    if (route === "POST /auth/login") {
      assert.equal(request.headers.origin, webOrigin);
      const credentials = json();
      const account = accounts.find((item) => item.email === credentials.email && item.isActive);
      if (!account || credentials.password !== password) return reply(response, 401);
      sessionUser = account;
      return issueSession(response, true);
    }
    if (route === "POST /auth/refresh") {
      assert.equal(request.headers.origin, webOrigin);
      if (!cookie || request.headers.cookie !== "clearsight_refresh=" + cookie) return reply(response, 401);
      refreshes++;
      return issueSession(response, false);
    }
    if (!token || request.headers.authorization !== "Bearer " + token) return reply(response, 401);
    if (route === "POST /auth/logout") {
      token = undefined;
      cookie = undefined;
      sessionUser = undefined;
      return reply(response, 204, undefined, {
        "Set-Cookie": "clearsight_refresh=; Max-Age=0; Path=/api/auth; HttpOnly; Secure; SameSite=Lax",
      });
    }
    if (route === "GET /auth/me") return reply(response, 200, sessionUser);
    if (url.pathname.startsWith("/admin/users")) {
      if (sessionUser.role !== "ADMIN") return reply(response, 403);
      if (route === "GET /admin/users") {
        const query = url.searchParams.get("q")?.toLowerCase() ?? "";
        const role = url.searchParams.get("role");
        const active = url.searchParams.get("isActive");
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const matching = accounts.filter((account) =>
          (account.fullName + " " + account.email).toLowerCase().includes(query) &&
          (!role || account.role === role) && (!active || String(account.isActive) === active));
        return reply(response, 200, { items: matching.slice(offset, offset + limit), limit, offset, total: matching.length });
      }
      return reply(response, 405, { detail: "La revisión visual usa cuentas de ejemplo de solo lectura." });
    }
    if (route === "GET /export/gold-standard") {
      if (sessionUser.role === "OFTALMOLOGO") return reply(response, 403);
      const since = url.searchParams.get("since");
      const matches = !since || Date.parse(since) < Date.parse(createdAt);
      if (url.searchParams.get("format") === "json") {
        const items = matches ? [{ inference_id: inferenceId, validated_class: 1 }] : [];
        return reply(response, 200, { count: items.length, has_more: false, generated_at: createdAt, items });
      }
      response.writeHead(200, { "Content-Type": "text/csv" });
      return response.end(`inference_id,validated_class\n${matches ? `${inferenceId},1\n` : ""}`);
    }
    if (route === "GET /patients") return reply(response, 200, [{ id: patientId, externalCode: "SMOKE" }]);
    if (route === "POST /consultations") {
      consultations++;
      assert.equal(json().patientId, patientId);
      clinical = json().clinicalData;
      assert.equal(Object.keys(clinical).length, 11);
      assert.equal(clinical["Phakic/Pseudophakic"], 1);
      assert.equal(clinical.dioptre_1, -2.5);
      return reply(response, 201, { id: consultationId, patientId, createdAt });
    }

    const consultation = "/consultations/" + consultationId;
    if (route === "POST " + consultation + "/images") {
      uploads++;
      assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
      assert.match(bytes.toString("latin1"), /name="eyeSide"\r\n\r\nOS\r\n/);
      assert.ok(bytes.includes(images.raw));
      image = { id: imageId, eyeSide: "OS" };
      return reply(response, 201, image);
    }
    if (route === "POST /inferences") {
      attempts++;
      const key = request.headers["idempotency-key"];
      const payload = json();
      assert.match(key, /^[A-Za-z0-9._:-]{1,128}$/);
      assert.equal(payload.imageId, imageId);
      assert.equal(payload.eyeSide, "OS");
      assert.deepEqual(payload.clinicalFeatures, clinical);
      if (!intent) {
        intent = { key, payload };
        return reply(response, 503);
      }
      assert.deepEqual({ key, payload }, intent);
      return reply(response, 202, { inferenceId, status: "QUEUED" });
    }
    if (route === "POST " + consultation + "/required-executions") {
      assert.deepEqual(json().executionIds, [inferenceId]);
      frozen = true;
      return reply(response, 200, { id: consultationId });
    }
    if (route === "GET " + consultation) {
      return reply(response, 200, {
        id: consultationId, patientId, createdAt, clinicalData: clinical, images: [image],
        requiredExecutionIds: frozen ? [inferenceId] : [],
        analysisState: reads >= 2 ? "COMPLETED" : "IN_PROGRESS",
        reportState: reads >= 3 ? "AVAILABLE" : "REPORT_PENDING",
        completionState: reads >= 3 ? "COMPLETE" : "INCOMPLETE",
        pollingStop: reads >= 3 ? "COMPLETE" : "CONTINUE",
      });
    }

    const inference = "/inferences/" + inferenceId;
    if (route === "GET " + inference) {
      if (!holdAnalysis || reads === 0) reads++;
      const queued = reads === 1;
      const published = reads >= 3;
      const resultStatus = queued ? "PENDING" : "AVAILABLE";
      return reply(response, 200, {
        id: inferenceId, imageId, createdAt, predictedClass: queued ? null : 1,
        confidence: queued ? null : 0.92,
        probabilities: queued ? {} : { Glaucoma: 0.03, Non_Glaucoma: 0.92, Suspicious_Glaucoma: 0.05 },
        cdr: queued ? null : 0.42, cdrVertical: queued ? null : 0.38,
        modelVersion: "fixture-model", status: queued ? "QUEUED" : "COMPLETED",
        pollingStop: published ? "COMPLETE" : "CONTINUE",
        delivery: {
          resultStatus, evidenceStatus: resultStatus, pdfStatus: published ? "AVAILABLE" : "PENDING",
          complete: published, reviewRequired: false, failed: false, deliveryTerminal: published,
        },
      }, published ? {} : { "Retry-After": "2" });
    }
    if (route === "GET " + inference + "/artifacts") {
      const type = url.searchParams.get("type");
      assert.ok(type === "mask" || type === "overlay");
      return reply(response, 200, {
        items: [{ artifactId: randomUUID(), version: 1, reference: { artifactType: type, status: "AVAILABLE" } }],
        total: 1, limit: 1, offset: 0,
      });
    }
    if (["GET " + inference + "/artifacts/mask/url", "GET " + inference + "/artifacts/overlay/url"].includes(route)) {
      assert.equal(url.searchParams.get("version"), "1");
      const type = url.pathname.endsWith("/mask/url") ? "mask" : "overlay";
      return reply(response, 200, { status: "AVAILABLE", url: apiOrigin + "/" + type + ".png", expiresInSeconds: 60 });
    }
    if (route === "GET " + inference + "/reports") {
      assert.ok(reads >= 3);
      return reply(response, 200, [{ reportId: inferenceId, version: 1, status: "AVAILABLE" }]);
    }
    if (route === "GET " + inference + "/reports/1/url") {
      return reply(response, 200, { status: "AVAILABLE", url: apiOrigin + "/fixture.pdf", expiresInSeconds: 60 });
    }
    if (route === "POST /feedback") {
      feedback = json();
      assert.equal(feedback.consultation_id, consultationId);
      assert.equal(feedback.inference_id, inferenceId);
      assert.ok([null, 0, 1, 2].includes(feedback.validated_class));
      assert.equal(typeof feedback.is_gold_standard, "boolean");
      return reply(response, 200, { id: randomUUID(), created_at: createdAt, ...feedback });
    }
    assert.fail("Unexpected test request: " + route);
  }

  return {
    user, researcher, admin, password, patientId, consultationId, inferenceId, pdf, errors,
    setOrigins(web, api) { webOrigin = web; apiOrigin = api; },
    setImages(value) { images = value; },
    holdAnalysis(value) { holdAnalysis = value; },
    async handle(request, response) {
      try {
        await handle(request, response);
      } catch (error) {
        errors.push(error);
        reply(response, 500);
      }
    },
    assertComplete() {
      assert.equal(consultations, 1);
      assert.equal(uploads, 1);
      assert.equal(attempts, 2);
      assert.equal(feedback?.validated_class, 1);
      assert.equal(feedback?.is_gold_standard, false);
      assert.ok(refreshes > 0, "Reload should restore the session");
      assert.deepEqual(errors, []);
    },
  };
}

module.exports = { createClinicalFixture };
