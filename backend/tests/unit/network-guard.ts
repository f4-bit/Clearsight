import http from "node:http";
import https from "node:https";
import { Socket } from "node:net";

/**
 * Unit-runner network trap.
 *
 * Only direct TCP sockets, fetch and the HTTP(S) client entry points are
 * blocked. Vitest's own IPC channel (named pipe / Unix socket / inherited stdio)
 * is not a TCP connect and stays untouched.
 */
const BLOCKED_MESSAGE = "Unit tests may not access the network";

type Connect = (...args: unknown[]) => unknown;

const socketPrototype = Socket.prototype as unknown as { connect: Connect };
const originalConnect = socketPrototype.connect;

function isTcpTarget(target: unknown): boolean {
  if (Array.isArray(target)) {
    // Node's `net.connect()` normalizes its arguments into an array before
    // delegating to Socket.prototype.connect.
    return target.some(isTcpTarget);
  }
  if (typeof target === "number") {
    return true;
  }
  if (typeof target === "string") {
    return /^\d+$/.test(target);
  }
  if (target !== null && typeof target === "object") {
    const options = target as { path?: unknown; port?: unknown; host?: unknown };
    if (options.path !== undefined) {
      return false;
    }
    return options.port !== undefined || options.host !== undefined;
  }
  return false;
}

socketPrototype.connect = function connect(this: Socket, ...args: unknown[]): unknown {
  if (isTcpTarget(args[0])) {
    throw new Error(`${BLOCKED_MESSAGE}: net.Socket.connect`);
  }
  return originalConnect.apply(this, args);
};

const blockedFetch = async (): Promise<never> => {
  throw new Error(`${BLOCKED_MESSAGE}: fetch`);
};
(globalThis as unknown as { fetch: typeof fetch }).fetch = blockedFetch as typeof fetch;

for (const module of [http, https]) {
  const client = module as unknown as {
    request: (...args: unknown[]) => unknown;
    get: (...args: unknown[]) => unknown;
  };
  client.request = () => {
    throw new Error(`${BLOCKED_MESSAGE}: http(s).request`);
  };
  client.get = () => {
    throw new Error(`${BLOCKED_MESSAGE}: http(s).get`);
  };
}
