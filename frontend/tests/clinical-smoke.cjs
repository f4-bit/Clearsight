const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { resolve } = require("node:path");
const { createInterface } = require("node:readline");
const { chromium } = require("playwright");
const { createClinicalFixture } = require("./clinical-smoke-api.cjs");

async function listen(server) {
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  server.closeAllConnections();
  await closed;
}

class InspectionEnded extends Error {}

function createInspection(page) {
  return async (message, finished = false) => {
    if (page.isClosed()) throw new InspectionEnded("Ventana de revisión cerrada.");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let windowClosed;
    try {
      const instruction = finished
        ? "Pulsa Enter en PowerShell o cierra Chromium para salir."
        : "Pulsa Enter en PowerShell para continuar.";
      console.log("\n" + message + " " + instruction);
      await new Promise((resume) => {
        windowClosed = resume;
        page.once("close", windowClosed);
        terminal.once("line", resume);
        terminal.once("close", resume);
      });
      if (page.isClosed()) throw new InspectionEnded("Ventana de revisión cerrada.");
    } finally {
      page.off("close", windowClosed);
      terminal.close();
    }
  };
}

async function login(page, fixture, user = fixture.user) {
  await page.getByLabel("Correo electrónico").fill(user.email);
  await page.getByLabel("Contraseña").fill(fixture.password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((url) => url.pathname === "/");
}

async function logout(page) {
  if (new URL(page.url()).pathname === "/login") return;
  const [response] = await Promise.all([
    page.waitForResponse((item) => new URL(item.url()).pathname === "/api/auth/logout"),
    page.getByRole("button", { name: "Cerrar sesión" }).click(),
  ]);
  assert.equal(response.status(), 204);
  await page.waitForURL("**/login");
}

async function openCase(page, webOrigin, fixture) {
  const path = "/studies/" + fixture.consultationId;
  if (new URL(page.url()).pathname === path) return;
  if (new URL(page.url()).pathname === "/login") await login(page, fixture);
  await page.goto(webOrigin + path);
}

function requireCapture(page) {
  if (new URL(page.url()).pathname !== "/capture") {
    throw new InspectionEnded("Saliste de la captura antes de enviar el estudio. Ejecuta la revisión visual de nuevo para empezar otra captura.");
  }
}

async function createDemoImages(page) {
  const encoded = await page.evaluate(async () => {
    const retina = new Image();
    retina.src = "/retina-editorial.webp";
    await retina.decode();
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const context = canvas.getContext("2d");
    const saveImage = () => {
      context.fillStyle = "#060b12";
      context.fillRect(115, 471, 282, 31);
      context.fillStyle = "#edf3f8";
      context.font = "bold 14px monospace";
      context.textAlign = "center";
      context.fillText("IMAGEN DE DEMOSTRACIÓN · OS", 256, 491);
      return canvas.toDataURL().split(",")[1];
    };
    const drawContours = (filled) => {
      for (const [x, y, color] of [[62, 77, "#8ef5e2"], [29, 30, "#ffd09a"]]) {
        context.beginPath();
        context.ellipse(256, 256, x, y, -0.14, 0, Math.PI * 2);
        context.strokeStyle = context.fillStyle = color;
        context.lineWidth = 3;
        if (filled) context.fill();
        else context.stroke();
      }
    };
    context.drawImage(retina, 0, 0, size, size);
    const raw = saveImage();
    const edge = retina.naturalWidth;
    context.drawImage(retina, edge * .55, edge * .28, edge * .4, edge * .4, 0, 0, size, size);
    drawContours(false);
    const overlay = saveImage();
    context.fillStyle = "#090f18";
    context.fillRect(0, 0, size, size);
    drawContours(true);
    return { raw, overlay, mask: saveImage() };
  });
  return Object.fromEntries(Object.entries(encoded).map(([name, data]) => [name, Buffer.from(data, "base64")]));
}

async function fillClinicalFields(page) {
  const fields = page.locator("aside fieldset");
  await fields.getByLabel("Sexo").selectOption("1");
  const values = [
    [/^Edad/, "62"], [/^Esfera refractiva/, "-2,5"], [/^Cilindro refractivo/, "1.5"],
    [/^Eje astigmático/, "85"], [/^Cristalino/, "1"], [/^Tonómetro neumático/, "17"],
    [/^Tonómetro Perkins/, "15"], [/^Paquimetría/, "540"], [/^Longitud axial/, "24.2"],
    [/^Desviación media/, "-1.5"],
  ];
  for (const [label, value] of values) await fields.getByLabel(label).fill(value);
}

async function exercise(page, webOrigin, fixture, inspect) {
  await page.goto(webOrigin);
  await page.waitForURL("**/login");
  await page.getByRole("heading", { name: "Inicia sesión" }).waitFor();
  await inspect?.("Inicio de sesión. Pulsa «Mostrar clave» si quieres revisar el control. El recorrido inicia sesión al continuar.");
  if (new URL(page.url()).pathname === "/login") await login(page, fixture);
  const captureLink = page.getByRole("link", { name: "Iniciar captura" });
  if (new URL(page.url()).pathname === "/") {
    await captureLink.waitFor();
    await inspect?.("Estación clínica. Puedes iniciar una captura o abrir una consulta por su identificador.");
  }
  if (new URL(page.url()).pathname === "/") await captureLink.click();
  if (inspect) {
    await page.getByLabel("Archivo OS", { exact: true }).waitFor({ state: "attached" });
    await inspect("Captura vacía. Revisa el espacio de los dos ojos y del formulario.");
    requireCapture(page);
  }

  const images = await createDemoImages(page);
  fixture.setImages(images);
  await page.locator("select").filter({
    has: page.locator("option", { hasText: "SMOKE" }),
  }).selectOption(inspect ? fixture.patientId : "new");
  if (!inspect) await page.getByLabel("Código pseudónimo (opcional)").fill("HISTORIAL-SMOKE");
  await page.getByLabel("Archivo OS", { exact: true }).setInputFiles({
    name: "retina-demo-os.png", mimeType: "image/png", buffer: images.raw,
  });
  await fillClinicalFields(page);
  await inspect?.("Captura lista. Revisa la imagen de prueba del ojo izquierdo y el formulario.");
  requireCapture(page);
  fixture.holdAnalysis(true);
  await page.getByRole("button", { name: "Enviar estudio" }).click();
  await page.getByRole("button", { name: "Reintentar envío" }).click();
  await page.getByRole("heading", { name: "Análisis en cola" }).waitFor();
  const steps = page.getByRole("list", { name: "Etapas del estudio" });
  const currentStep = steps.locator('[aria-current="step"]');
  await currentStep.getByText("Análisis", { exact: true }).waitFor();
  assert.equal(await steps.locator('[data-state="done"]').count(), 2);
  await page.getByRole("link", { name: "Ver seguimiento del caso" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "OD Sin imagen" }).isDisabled(), true);
  await page.getByRole("img", { name: "Retinografía OS" }).evaluate((image) => image.decode());
  const variables = page.getByRole("button", { name: "Variables clínicas registradas" });
  const studyDialog = page.getByRole("dialog", { name: "Variables clínicas registradas" });
  const documentHeight = () => page.evaluate(() => document.documentElement.scrollHeight);
  const beforeDialog = await documentHeight();
  await variables.click();
  await studyDialog.getByText("62 años", { exact: true }).waitFor();
  assert.equal(await documentHeight(), beforeDialog);
  await page.keyboard.press("Escape");
  await studyDialog.waitFor({ state: "hidden" });
  assert.equal(await variables.evaluate((button) => button === document.activeElement), true);
  await inspect?.("Análisis pendiente. Revisa la etapa actual, la retinografía y el panel de variables.");
  fixture.holdAnalysis(false);
  if (new URL(page.url()).pathname === "/capture") {
    const retryStatus = page.getByRole("button", { name: "Consultar estado" });
    if (await retryStatus.isVisible()) await retryStatus.click();
    await page.getByText("0,38", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "Estudio completado" }).waitFor();
    await page.getByRole("link", { name: "Abrir caso clínico" }).click();
    await page.waitForURL("**/studies/" + fixture.consultationId);
  }
  await openCase(page, webOrigin, fixture);
  await page.reload();

  const eyeSelector = page.getByRole("group", { name: "Ojo de la revisión" });
  const missingEye = eyeSelector.getByRole("button", { name: "OD Ojo derecho Sin ejecución" });
  await missingEye.waitFor();
  assert.equal(await missingEye.isDisabled(), true);
  assert.equal(await eyeSelector.getByRole("button", { name: "OS Ojo izquierdo" }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("region", { name: /^OD/ }).count(), 0);
  await page.getByRole("region", { name: /^OS/ }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Vincular zoom y desplazamiento" }).count(), 0);
  await page.getByText("92.0%", { exact: true }).first().waitFor();
  await page.getByText("0,42", { exact: true }).waitFor();
  const overlay = page.getByRole("img", { name: /contornos.*OS/i });
  await overlay.waitFor();
  await overlay.evaluate((image) => image.decode());
  await page.getByRole("button", { name: "Máscara", exact: true }).click();
  await page.getByRole("img", { name: /máscara de segmentación OS/i }).evaluate((image) => image.decode());
  await page.getByRole("button", { name: "Contornos", exact: true }).click();
  if (!inspect) {
    const filter = page.getByLabel("Filtro OS");
    await filter.selectOption("clahe");
    await overlay.evaluate((image) => image.decode());
    await page.getByRole("button", { name: "Grad-CAM" }).click();
    await page.getByRole("img", { name: "Grad-CAM de la clase predicha" }).evaluate((image) => image.decode());
    const opacity = page.getByRole("slider", { name: "Opacidad del mapa" });
    await opacity.fill("25");
    assert.equal(await page.getByRole("img", { name: "Grad-CAM de la clase predicha" }).evaluate((img) => img.style.opacity), "0.25");
  }
  if (inspect) {
    await inspect("Caso clínico. Explora el visor y las secciones del panel derecho.");
  } else {
    await logout(page);
  }
  await inspect?.("Variables registradas. Las mediciones están al lado del visor.");
  await openCase(page, webOrigin, fixture);

  await page.getByRole("button", { name: "Variables clínicas", exact: true }).click();
  const clinical = page.locator("#case-variables");
  await clinical.getByRole("heading", { name: "Variables clínicas registradas" }).waitFor();
  assert.equal(await clinical.locator("dt").count(), 11);
  assert.equal(await page.locator("#case-result").isVisible(), false);
  if (!inspect) {
    assert.equal(await clinical.evaluate((panel) => {
      const scrollArea = panel.parentElement;
      return scrollArea.scrollHeight > scrollArea.clientHeight;
    }), false, "Clinical values should fit at 1366×768");
  }

  await page.getByRole("button", { name: "Informe", exact: true }).click();
  await page.getByText("Informe disponible.", { exact: true }).waitFor();
  await page.getByRole("button", { name: /^(Ver versiones|Actualizar)$/ }).click();
  await page.getByRole("button", { name: "Preparar descarga" }).click();
  const pdfLink = page.getByRole("link", { name: /Descargar PDF/ });
  await pdfLink.waitFor();
  const [download] = await Promise.all([page.waitForEvent("download"), pdfLink.click()]);
  assert.equal(download.suggestedFilename(), "clearsight-smoke.pdf");
  assert.deepEqual(await readFile(await download.path()), fixture.pdf);
  await inspect?.("Informe listo. Puedes descargar el PDF de prueba y revisar sus versiones.");
  await openCase(page, webOrigin, fixture);

  await page.getByRole("button", { name: "Dictamen", exact: true }).click();
  await page.getByLabel("Clasificación clínica").selectOption("1");
  await page.getByRole("checkbox", { name: /referencia validada/ }).uncheck();
  await page.getByRole("button", { name: "Guardar dictamen" }).click();
  await page.getByText("Dictamen guardado.", { exact: true }).waitFor();
  await page.getByText("Completo", { exact: true }).waitFor();
  fixture.assertComplete();
  await inspect?.("Dictamen. Puedes cambiar la clasificación de prueba y revisar el guardado.");
}

async function reviewRoles(page, fixture, inspect) {
  await logout(page);
  await login(page, fixture, fixture.researcher);
  await page.getByRole("heading", { name: "Investigación", exact: true }).waitFor();
  const executionId = page.getByLabel("ID de ejecución");
  const openAnalysis = page.getByRole("button", { name: "Abrir análisis" });
  const csvButton = page.getByRole("button", { name: "Descargar CSV" });
  await csvButton.waitFor();
  if (!inspect) {
    await page.getByRole("button", { name: "Segmentación", exact: true, pressed: true }).waitFor();
    await csvButton.click();
    await page.getByText("No hay referencias validadas autorizadas con estos filtros.").waitFor();
    await logout(page);
    await login(page, fixture);
    await page.getByRole("link", { name: "Pacientes e historial de estudios" }).click();
    await page.getByRole("link", { name: "HISTORIAL-SMOKE" }).click();
    await page.getByRole("link", { name: /^Estudio ·/ }).click();
    await page.getByRole("button", { name: "Dictamen", exact: true }).click();
    assert.equal(await page.getByLabel("Clasificación clínica").inputValue(), "1");
    await page.getByRole("checkbox", { name: /referencia validada/ }).check();
    await page.getByRole("button", { name: "Guardar dictamen" }).click();
    await page.getByText("Dictamen guardado.", { exact: true }).waitFor();
    await logout(page);
    await login(page, fixture, fixture.researcher);
    fixture.grantExport(false);
    await csvButton.click();
    await page.getByText("Tu cuenta necesita un permiso vigente de exportación.").waitFor();
    fixture.grantExport(true);
    const layers = page.getByRole("group", { name: "Capas del análisis de ejemplo" });
    const dataLayer = layers.getByRole("button", { name: "Datos" });
    assert.equal(await dataLayer.getAttribute("aria-pressed"), "true");
    await dataLayer.click();
    assert.equal(await dataLayer.getAttribute("aria-pressed"), "true");
    await executionId.focus();
    assert.equal(await layers.getByRole("button", { name: "Retinografía" }).getAttribute("aria-pressed"), "true");
    const [csv] = await Promise.all([page.waitForEvent("download"), csvButton.click()]);
    assert.equal(await dataLayer.getAttribute("aria-pressed"), "true");
    assert.equal(csv.suggestedFilename(), "clearsight-gold-standard.csv");
    assert.equal(await readFile(await csv.path(), "utf8"), `inference_id,validated_class\n${fixture.inferenceId},1\n`);
    await page.getByText("JSON", { exact: true }).click();
    await page.getByLabel("Desde (opcional)", { exact: true }).fill("2099-01-01");
    await page.getByRole("button", { name: "Descargar JSON" }).click();
    await page.getByText("No hay referencias validadas autorizadas con estos filtros.", { exact: true }).waitFor();
    await page.getByLabel("Desde (opcional)", { exact: true }).fill("2020-01-01");
    await page.getByLabel("Límite de registros").fill("1");
    const [json, exportResponse] = await Promise.all([
      page.waitForEvent("download"),
      page.waitForResponse((response) => new URL(response.url()).pathname === "/api/export/gold-standard"),
      page.getByRole("button", { name: "Descargar JSON" }).click(),
    ]);
    assert.equal(json.suggestedFilename(), "clearsight-gold-standard.json");
    assert.equal(JSON.parse(await readFile(await json.path(), "utf8")).items[0].inference_id, fixture.inferenceId);
    const query = new URL(exportResponse.url()).searchParams;
    assert.equal(query.get("format"), "json");
    assert.equal(query.get("limit"), "1");
    assert.equal(query.get("since"), await page.evaluate(() => new Date("2020-01-01T00:00:00").toISOString()));
    await executionId.fill("123");
    await openAnalysis.click();
    await page.getByText("Ingresa el identificador completo en formato UUID.").waitFor();
  }
  await executionId.fill(fixture.inferenceId);
  await inspect?.("Investigación. El formulario contiene un ID de prueba. Puedes abrirlo o descargar referencias validadas.");
  if (new URL(page.url()).pathname === "/login") await login(page, fixture, fixture.researcher);
  if (new URL(page.url()).pathname === "/") {
    await executionId.fill(fixture.inferenceId);
    await openAnalysis.click();
  }
  await page.waitForURL("**/executions/" + fixture.inferenceId);
  await page.getByRole("button", { name: "Contornos" }).click();
  await page.getByRole("img", { name: "Contornos" }).evaluate((image) => image.decode());
  await inspect?.("Consulta de ejecución. Revisa la evidencia y el informe desde el perfil de investigación.");
  if (!inspect) {
    const modes = page.getByRole("group", { name: "Modo de evidencia" });
    const mask = modes.getByRole("button", { name: "Máscara" });
    await mask.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("img", { name: "Máscara" }).evaluate((image) => image.decode());
    assert.equal(await mask.getAttribute("aria-pressed"), "true");
    assert.equal(await page.getByRole("img", { name: "Contornos" }).isVisible(), false);
    await modes.getByRole("button", { name: "Contornos" }).click();
    await page.getByRole("img", { name: "Contornos" }).waitFor();
    await page.getByRole("button", { name: "Ver versiones" }).click();
    await page.getByRole("button", { name: "Preparar descarga" }).click();
    const [report] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Descargar PDF · v1" }).click(),
    ]);
    assert.deepEqual(await readFile(await report.path()), fixture.pdf);
    fixture.grantReads({ result: false, artifacts: true, pdf: false });
    await page.reload();
    await page.getByRole("button", { name: "Consultar de nuevo" }).waitFor();
    await page.getByRole("button", { name: "Grad-CAM" }).click();
    await page.getByRole("img", { name: "Grad-CAM de la clase predicha" }).evaluate((image) => image.decode());
    fixture.grantReads({ result: false, artifacts: false, pdf: true });
    await page.reload();
    await page.getByRole("button", { name: "Ver versiones" }).click();
    await page.getByRole("button", { name: "Preparar descarga" }).click();
    await page.getByRole("link", { name: "Descargar PDF · v1" }).waitFor();
    fixture.grantReads({ result: true, artifacts: false, pdf: false });
    await page.reload();
    await page.getByText(/^92[,.]0\s*%$/).first().waitFor();
    assert.equal(await page.getByRole("button", { name: "Grad-CAM" }).count(), 0);
    fixture.grantReads({ result: true, artifacts: true, pdf: true });
    await page.getByRole("link", { name: "Volver a Investigación" }).click();
    await page.getByRole("heading", { name: "Investigación", exact: true }).waitFor();
  }
  await logout(page);
  await login(page, fixture, fixture.admin);
  await page.getByRole("link", { name: "Gestionar usuarios" }).click();
  await page.getByText("Oftalmología de prueba", { exact: true }).waitFor();
  if (!inspect) {
    await page.getByText("3 cuentas", { exact: true }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "Páginas de cuentas" }).count(), 0);

    const search = page.getByRole("searchbox", { name: "Nombre o correo" });
    await search.fill("research@example.invalid");
    await search.press("Enter");
    await page.getByText("1 cuenta", { exact: true }).waitFor();
    const edit = page.getByRole("button", { name: "Editar Investigación de prueba" });
    await edit.click();
    const editor = page.getByRole("dialog", { name: "Editar usuario" });
    const name = editor.getByLabel("Nombre completo");
    await name.waitFor();
    assert.equal(await name.inputValue(), "Investigación de prueba");
    assert.equal(await name.evaluate((input) => input === document.activeElement), true);
    await editor.getByRole("combobox", { name: "Rol", exact: true }).selectOption("OFTALMOLOGO");
    await editor.getByText("Este cambio revoca las sesiones de la cuenta.").waitFor();
    await editor.getByRole("button", { name: "Cancelar" }).click();
    await editor.waitFor({ state: "hidden" });
    assert.equal(await edit.evaluate((button) => button === document.activeElement), true);
    assert.equal(await search.inputValue(), "research@example.invalid");

    const create = page.getByRole("button", { name: "Crear usuario" });
    await create.click();
    const creator = page.getByRole("dialog", { name: "Crear usuario" });
    await creator.getByLabel("Contraseña inicial").waitFor();
    await page.keyboard.press("Escape");
    await creator.waitFor({ state: "hidden" });
    assert.equal(await create.evaluate((button) => button === document.activeElement), true);
    assert.equal(await search.inputValue(), "research@example.invalid");
    await create.click();
    await creator.getByLabel("Nombre completo").fill("Cuenta de integración");
    await creator.getByLabel("Correo", { exact: true }).fill("integration@example.invalid");
    await creator.getByLabel("Contraseña inicial").fill("smoke-secret-example");
    await creator.getByRole("button", { name: "Guardar" }).click();
    await page.getByText("Usuario creado.", { exact: true }).waitFor();
    await search.fill("integration@example.invalid");
    await search.press("Enter");
    await page.getByRole("button", { name: "Editar Cuenta de integración" }).click();
    await editor.getByLabel("Nombre completo").fill("Cuenta modificada");
    await editor.getByRole("button", { name: "Guardar" }).click();
    await page.getByRole("button", { name: "Editar Cuenta modificada" }).waitFor();
  }
  await inspect?.("Administración de usuarios. Puedes revisar los filtros y guardar cambios en cuentas de prueba.", true);
}

async function verifyBilateral(page, fixture) {
  await login(page, fixture);
  await page.getByRole("link", { name: "Iniciar captura" }).click();
  const images = await createDemoImages(page);
  fixture.setImages(images);
  await page.locator("select").filter({ has: page.locator("option", { hasText: "SMOKE" }) }).selectOption(fixture.patientId);
  // The OD input is a synthetic mask; it deliberately exercises the quality gate.
  const rightFile = { name: "od-quality-test.png", mimeType: "image/png", buffer: images.mask };
  await page.getByLabel("Archivo OD", { exact: true }).setInputFiles(rightFile);
  await page.getByLabel("Archivo OS", { exact: true }).setInputFiles({ name: "os.png", mimeType: "image/png", buffer: images.raw });
  await fillClinicalFields(page);
  await page.getByRole("button", { name: "Enviar estudio" }).click();
  await page.getByRole("heading", { name: "Revisión requerida" }).waitFor();
  await page.getByRole("link", { name: /Abrir caso clínico|Ver seguimiento del caso/ }).click();
  const od = page.getByRole("region", { name: /^OD/ });
  const os = page.getByRole("region", { name: /^OS/ });
  await od.waitFor();
  assert.ok((await od.boundingBox()).x < (await os.boundingBox()).x);
  assert.equal(await od.getByRole("button", { name: "Grad-CAM" }).count(), 0);
  await os.getByRole("button", { name: "Grad-CAM" }).waitFor();
  await os.getByRole("button", { name: "Aumentar zoom OS" }).click();
  await od.getByText("125%").waitFor();
  await page.getByRole("button", { name: "Dictamen", exact: true }).click();
  assert.equal(await page.getByLabel("Clasificación clínica").count(), 0);
  await page.getByRole("button", { name: "Resultados", exact: true }).click();
  await page.getByText("Reanalizar OD", { exact: true }).click();
  await page.getByLabel("Archivo OD", { exact: true }).setInputFiles(rightFile);
  await page.getByRole("button", { name: "Enviar reanálisis" }).click();
  await page.getByRole("link", { name: "Abrir nueva ejecución" }).click();
  await page.waitForURL((url) => url.searchParams.get("execution") === fixture.childId);
  await page.reload();
  await od.getByRole("button", { name: "Grad-CAM" }).waitFor();
  await os.getByRole("button", { name: "Grad-CAM" }).waitFor();
  await page.getByRole("link", { name: "Estudio original" }).click();
  await page.getByText("Reanalizar OD", { exact: true }).waitFor();
}

async function verifyRecovery(page, fixture) {
  await logout(page);
  await page.getByRole("link", { name: "Olvidé mi contraseña" }).click();
  await page.waitForURL("**/login/recuperar");
  await page.getByRole("heading", { name: "Recuperar acceso" }).waitFor();
  await page.getByLabel("Correo electrónico").fill(fixture.user.email);
  const [accepted] = await Promise.all([
    page.waitForResponse((res) => new URL(res.url()).pathname === "/api/auth/password/forgot"),
    page.getByRole("button", { name: "Solicitar código" }).click(),
  ]);
  assert.equal(accepted.status(), 202);
  const codeField = page.getByLabel("Código de recuperación");
  await codeField.waitFor();
  const code = fixture.getRecoveryCode();
  const newPassword = "solo-para-smoke-recuperacion";
  await codeField.fill(code);
  await page.getByLabel("Nueva contraseña").fill(newPassword);
  await page.getByRole("button", { name: "Guardar contraseña" }).click();
  await page.getByRole("heading", { name: "Contraseña actualizada" }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Ya tengo un código" }).click();
  await codeField.fill(code);
  await page.getByLabel("Nueva contraseña").fill(newPassword);
  await page.getByRole("button", { name: "Guardar contraseña" }).click();
  await page.getByText("El código es inválido o ya venció.").waitFor();
  await page.getByRole("link", { name: "Volver a iniciar sesión" }).click();
  await login(page, { ...fixture, password: newPassword });
}

async function main() {
  const visual = process.argv.includes("--visual");
  let fixture = createClinicalFixture();
  const api = createServer((req, res) => fixture.handle(req, res));
  let serveNext;
  const web = createServer((request, response) => {
    if (serveNext) return serveNext(request, response);
    response.writeHead(503).end();
  });
  let app, browser;
  try {
    const apiOrigin = "http://127.0.0.1:" + await listen(api);
    const port = await listen(web);
    const webOrigin = "http://localhost:" + port;
    fixture.setOrigins(webOrigin, apiOrigin);
    process.env.API_INTERNAL_URL = apiOrigin;
    process.env.NEXT_TELEMETRY_DISABLED = "1";
    process.env.NODE_ENV = "production";
    const next = require("next");
    app = next({ dev: false, dir: resolve(__dirname, ".."), hostname: "localhost", port });
    await app.prepare();
    serveNext = app.getRequestHandler();

    browser = await chromium.launch({
      headless: !visual,
      args: visual ? ["--start-maximized"] : [],
    });
    const context = await browser.newContext({
      viewport: visual ? null : { width: 1366, height: 768 },
      acceptDownloads: true,
    });
    await context.route("**/*", (route) => {
      const origin = new URL(route.request().url()).origin;
      return origin === webOrigin || origin === apiOrigin ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => fixture.errors.push(error));
    const inspect = visual ? createInspection(page) : undefined;
    await exercise(page, webOrigin, fixture, inspect);
    await reviewRoles(page, fixture, inspect);
    assert.deepEqual(fixture.errors, []);
    if (!visual) {
      await logout(page);
      fixture = createClinicalFixture({ bilateral: true });
      fixture.setOrigins(webOrigin, apiOrigin);
      await verifyBilateral(page, fixture);
      await verifyRecovery(page, fixture);
      assert.deepEqual(fixture.errors, []);
    }
    console.log(visual ? "Recorrido visual completado." :
      "Smoke aprobado. Sesión y recuperación, captura unilateral y bilateral, reanálisis, evidencia, historial, PDF, dictamen y permisos.");
  } catch (failure) {
    if (failure instanceof InspectionEnded) {
      console.log(failure.message);
      return;
    }
    for (const error of fixture.errors) console.error(error);
    throw failure;
  } finally {
    try {
      await browser?.close();
    } finally {
      await Promise.all([close(web), close(api), app?.close()]);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
