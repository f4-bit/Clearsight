import type { SessionUser } from "@/types/api";

interface Credentials {
  accessToken: string;
}

let accessToken: string | null = null;
let refreshPending: Promise<void> | null = null;

export class ApiError extends Error {
  constructor(readonly status: number, readonly retryAfter: number | null = null) {
    super(apiMessage(status));
  }
}

function apiMessage(status: number): string {
  switch (status) {
    case 400: return "La solicitud contiene datos inválidos.";
    case 401: return "La sesión expiró. Inicia sesión de nuevo.";
    case 403: return "La operación no está disponible para esta cuenta.";
    case 404: return "El recurso no existe o esta cuenta no tiene acceso.";
    case 409: return "La solicitud entra en conflicto con un registro existente.";
    case 413: return "El archivo supera el tamaño permitido.";
    case 422: return "Revisa los datos y la lateralidad del ojo.";
    case 429: return "Se alcanzó el límite de intentos. Espera antes de volver a intentar.";
    default: return "El servicio no está disponible. Intenta de nuevo.";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : apiMessage(0);
}

export function retryAfterSeconds(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : null;
}

export function jsonBody(body: object): RequestInit {
  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function request(path: string, init: RequestInit = {}, bearer?: string | null) {
  const headers = new Headers(init.headers);
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  const response = await fetch(`/api${path}`, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "same-origin",
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new ApiError(response.status, retryAfterSeconds(response.headers.get("Retry-After")));
  }
  return response;
}

async function rotateRefresh(): Promise<void> {
  const response = await request("/auth/refresh", { method: "POST" });
  const credentials: Credentials = await response.json();
  accessToken = credentials.accessToken;
}

function refreshAccess(): Promise<void> {
  if (!refreshPending) {
    const rotate =
      typeof navigator !== "undefined" && navigator.locks
        ? navigator.locks.request("clearsight-refresh", rotateRefresh)
        : rotateRefresh();
    refreshPending = Promise.resolve(rotate).finally(() => { refreshPending = null; });
  }
  return refreshPending;
}

async function withAccess<T>(operation: (bearer: string | null) => Promise<T>): Promise<T> {
  const attemptedToken = accessToken;
  try {
    return await operation(attemptedToken);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    try {
      if (!accessToken || attemptedToken === accessToken) await refreshAccess();
      return await operation(accessToken);
    } catch (refreshError) {
      if (refreshError instanceof ApiError && refreshError.status === 401) {
        accessToken = null;
        window.dispatchEvent(new Event("clearsight-session-ended"));
      }
      throw refreshError;
    }
  }
}

export function apiResponse(path: string, init?: RequestInit): Promise<Response> {
  return withAccess((token) => request(path, init, token));
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return (await apiResponse(path, init)).json() as Promise<T>;
}

export async function login(email: string, password: string): Promise<SessionUser> {
  const response = await request("/auth/login", { method: "POST", ...jsonBody({ email, password }) });
  const session: Credentials & { user: SessionUser } = await response.json();
  accessToken = session.accessToken;
  return session.user;
}

export async function restoreSession(): Promise<SessionUser> {
  if (!accessToken) await refreshAccess();
  return api<SessionUser>("/auth/me");
}

export async function logout(): Promise<void> {
  await apiResponse("/auth/logout", { method: "POST" });
  accessToken = null;
}

export function uploadImage<T>(
  consultationId: string,
  form: FormData,
  onProgress: (value: number | null) => void,
): Promise<T> {
  return withAccess((token) => new Promise<T>((resolve, reject) => {
    const upload = new XMLHttpRequest();
    upload.open("POST", `/api/consultations/${consultationId}/images`);
    if (token) upload.setRequestHeader("Authorization", `Bearer ${token}`);
    upload.responseType = "json";
    upload.timeout = 90_000;
    onProgress(null);
    upload.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round(100 * event.loaded / event.total));
    };
    upload.onload = () => {
      if (upload.status === 201 && upload.response) resolve(upload.response as T);
      else reject(new ApiError(upload.status));
    };
    upload.onerror = upload.ontimeout = upload.onabort = () => reject(new ApiError(0));
    upload.send(form);
  }));
}
