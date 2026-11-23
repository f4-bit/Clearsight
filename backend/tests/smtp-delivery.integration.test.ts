import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { smtpPasswordResetDelivery } from "../src/services/password-reset-smtp.js";

it("delivers a one-use code to a loopback SMTP mailbox", async () => {
  const message: string[] = [];
  const commands: string[] = [];
  const server = createServer((socket) => {
    let readingMessage = false;
    socket.write("220 localhost test relay\r\n");
    createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
      if (readingMessage) {
        if (line !== ".") { message.push(line); return; }
        readingMessage = false;
      } else {
        commands.push(line);
        if (line === "STARTTLS") { socket.write("454 TLS unavailable\r\n"); return; }
        if (line === "DATA") {
          readingMessage = true;
          socket.write("354 End with a dot\r\n");
          return;
        }
        if (line === "QUIT") { socket.end("221 Bye\r\n"); return; }
      }
      socket.write("250 OK\r\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const config = { RESET_SMTP_HOST: "127.0.0.1", RESET_SMTP_PORT: String((server.address() as AddressInfo).port),
      RESET_SMTP_FROM: "recovery@example.invalid", NODE_ENV: "test" };
    const recipient = "doctor@example.invalid";
    const rawToken = "local-mailbox-one-use-code";
    const expiresAt = new Date("2030-01-01T12:00:00Z");
    await smtpPasswordResetDelivery(config).deliver({ recipient, rawToken, expiresAt });
    expect(commands).toContain("RCPT TO:<doctor@example.invalid>");
    const body = message.join("\n").replaceAll("=\n", "");
    expect(body).toContain(rawToken);
    expect(body).toContain(expiresAt.toISOString());
    await expect(smtpPasswordResetDelivery({ ...config, NODE_ENV: "production" })
      .deliver({ recipient, rawToken, expiresAt })).rejects.toThrow();
    expect(commands.filter((line) => line === "DATA")).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
