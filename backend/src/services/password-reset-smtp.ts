import nodemailer from "nodemailer";
import { z } from "zod";
import type { PasswordResetDelivery } from "./password-reset-delivery.js";
import { createDisabledPasswordResetDelivery } from "./password-reset-delivery.js";

export function smtpPasswordResetDelivery(config: NodeJS.ProcessEnv): PasswordResetDelivery {
  const host = config.RESET_SMTP_HOST;
  if (!host) return createDisabledPasswordResetDelivery();
  const from = z.email().parse(config.RESET_SMTP_FROM);
  const port = z.coerce.number().int().min(1).max(65535).parse(config.RESET_SMTP_PORT || 587);
  const user = config.RESET_SMTP_USER;
  const pass = config.RESET_SMTP_PASSWORD;
  if (Boolean(user) !== Boolean(pass)) throw new Error("Configure both SMTP authentication fields");
  const transport = nodemailer.createTransport({
    host, port, secure: port === 465, requireTLS: config.NODE_ENV === "production" || Boolean(user),
    auth: user && pass ? { user, pass } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    disableUrlAccess: true, disableFileAccess: true,
  });
  return {
    mode: "SMTP",
    async deliver({ recipient, rawToken, expiresAt }) {
      await transport.sendMail({
        from, to: recipient, subject: "Restablecer tu contraseña de ClearSight",
        text: `Introduce este código en la pantalla de recuperación de ClearSight:\n\n${rawToken}\n\nVence a las ${expiresAt.toISOString()} (UTC).`,
      });
    },
  };
}
