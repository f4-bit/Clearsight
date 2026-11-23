const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

async function verifyStudy({ origin, email, password, patientId, consultationId, expectedClass, isolated = false }) {
  const site = new URL(origin);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(site.hostname);
  assert.ok(site.origin === origin && (site.protocol === "https:" || (local && site.protocol === "http:")),
    "Usa el origen HTTPS del frontend o un servidor local.");
  assert.ok(email && password && [patientId, consultationId].every((id) => /^[0-9a-f-]{36}$/i.test(id)),
    "Configura una cuenta de pruebas y los identificadores del paciente y del estudio.");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    if (isolated) await page.route("**/*", (route) => new URL(route.request().url()).origin === origin
      ? route.continue() : route.abort());
    await page.goto(site.origin + "/login");
    assert.equal(new URL(page.url()).origin, site.origin);
    await page.getByLabel("Correo electrónico").fill(email);
    await page.getByLabel("Contraseña").fill(password);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await page.getByRole("link", { name: "Pacientes e historial de estudios" }).waitFor();
    await page.goto(site.origin + "/patients/" + patientId);
    const study = page.locator(`a[href="/studies/${consultationId}"]`);
    await page.getByRole("heading", { name: "Historial de estudios" }).waitFor();
    while (!await study.count()) {
      const nextPage = page.getByRole("button", { name: "Siguiente" });
      assert.ok(await nextPage.count() && await nextPage.isEnabled(), "El estudio no aparece en el historial.");
      const previous = await page.locator('a[href^="/studies/"]').first().getAttribute("href");
      await nextPage.click();
      await page.locator(`a[href="${previous}"]`).waitFor({ state: "detached" });
      await page.getByRole("heading", { name: "Historial de estudios" }).waitFor();
    }
    await Promise.all([page.waitForURL(`**/studies/${consultationId}`), study.click()]);
    await page.reload();
    await page.getByRole("group", { name: "Ojo de la revisión" }).waitFor();
    await page.getByRole("button", { name: "Variables clínicas", exact: true }).click();
    assert.equal(await page.locator("#case-variables dt").count(), 11);
    if (expectedClass !== undefined) {
      await page.getByRole("button", { name: "Dictamen", exact: true }).click();
      assert.equal(await page.getByLabel("Clasificación clínica").inputValue(), String(expectedClass));
    }
    await page.getByRole("button", { name: "Cerrar sesión" }).click();
    await page.waitForURL("**/login");
  } finally { await browser.close(); }
}

// Integration runner: both HTTP servers use OS-assigned loopback ports.
async function verifyLocalStudy(startBackend, study) {
  let nextHandler;
  const server = createServer((req, res) => nextHandler ? nextHandler(req, res) : res.writeHead(503).end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const origin = "http://localhost:" + port;
  const previous = process.env.API_INTERNAL_URL;
  let app;
  try {
    process.env.API_INTERNAL_URL = await startBackend(origin);
    app = require("next")({ dev: false, dir: resolve(__dirname, ".."), hostname: "localhost", port });
    await app.prepare();
    nextHandler = app.getRequestHandler();
    await verifyStudy({ ...study, origin, isolated: true });
  } finally {
    if (previous === undefined) delete process.env.API_INTERNAL_URL;
    else process.env.API_INTERNAL_URL = previous;
    server.closeAllConnections();
    await Promise.all([new Promise((done) => server.close(done)), app?.close()]);
  }
}

module.exports = { verifyLocalStudy };

if (require.main === module) {
  verifyStudy({
    origin: process.env.SMOKE_WEB_ORIGIN, email: process.env.SMOKE_DOCTOR_EMAIL,
    password: process.env.SMOKE_DOCTOR_PASSWORD, patientId: process.env.SMOKE_PATIENT_ID,
    consultationId: process.env.SMOKE_CONSULTATION_ID,
  }).then(() => console.log("Estudio verificado en el backend conectado.")).catch(() => {
    console.error("Falló el recorrido conectado de sesión, historial y estudio.");
    process.exitCode = 1;
  });
}
