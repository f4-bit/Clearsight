/**
 * Password-reset delivery port.
 *
 * The default port is DISABLED and never sends anything. The memory sink is an
 * explicit test-only implementation that retains recipient + raw token locally
 * for assertions; it is never exposed by an HTTP endpoint and is not a global
 * singleton. An explicitly configured SMTP relay handles real delivery.
 */

export interface PasswordResetDeliveryMessage {
  readonly recipient: string;
  readonly rawToken: string;
  readonly expiresAt: Date;
}

export type PasswordResetDeliveryMode = "DISABLED" | "MEMORY" | "SMTP";

export interface PasswordResetDelivery {
  readonly mode: PasswordResetDeliveryMode;
  deliver(message: PasswordResetDeliveryMessage): Promise<void>;
}

export interface PasswordResetDeliveryRecord {
  readonly recipient: string;
  readonly rawToken: string;
  readonly expiresAt: Date;
}

export interface MemoryPasswordResetDelivery extends PasswordResetDelivery {
  readonly mode: "MEMORY";
  readonly delivered: readonly PasswordResetDeliveryRecord[];
  /** Makes exactly the next delivery fail, for compensation/race tests. */
  failNextDelivery(): void;
  clear(): void;
}

/** Generic delivery failure; callers must not include recipient/token details. */
export class PasswordResetDeliveryError extends Error {
  constructor() {
    super("password reset delivery failed");
    this.name = "PasswordResetDeliveryError";
  }
}

export function createDisabledPasswordResetDelivery(): PasswordResetDelivery {
  return {
    mode: "DISABLED",
    async deliver() {
      // The service checks mode first; reaching here is an internal misuse.
      throw new PasswordResetDeliveryError();
    },
  };
}

export function createMemoryPasswordResetDelivery(): MemoryPasswordResetDelivery {
  const delivered: PasswordResetDeliveryRecord[] = [];
  let failNext = false;

  return {
    mode: "MEMORY",
    get delivered() {
      return [...delivered];
    },
    async deliver(message) {
      if (failNext) {
        failNext = false;
        throw new PasswordResetDeliveryError();
      }
      delivered.push({
        recipient: message.recipient,
        rawToken: message.rawToken,
        expiresAt: message.expiresAt,
      });
    },
    failNextDelivery() {
      failNext = true;
    },
    clear() {
      delivered.length = 0;
      failNext = false;
    },
  };
}
