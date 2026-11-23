import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const id = "[0-9a-f-]{36}";
const permitted = {
  GET: new RegExp(
    `^/(auth/me|patients(?:/${id}(?:/consultations)?)?|consultations/${id}|inferences/${id}(?:/gradcam|/clahe|/artifacts(?:/(?:mask|overlay)/url)?|/reports(?:/[0-9]+/url)?)?|admin/users(?:/${id})?|export/gold-standard)$`,
    "i",
  ),
  POST: new RegExp(
    `^/(auth/(?:login|refresh|logout|password/(?:forgot|reset))|admin/users|patients|consultations(?:/${id}/(?:images|required-executions))?|inferences|feedback)$`,
    "i",
  ),
  PATCH: new RegExp(`^/admin/users/${id}$`, "i"),
};

const requestHeaders = [
  "authorization", "cookie", "origin", "sec-fetch-site", "content-type", "idempotency-key",
];
const responseHeaders = ["content-type", "content-disposition", "retry-after", "x-has-more"];

function responseError(status: number, message: string) {
  return Response.json({ message, statusCode: status }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function proxy(request: NextRequest, { params }: { params: { path: string[] } }) {
  const path = `/${params.path.join("/")}`;
  const method = request.method as keyof typeof permitted;
  if (!permitted[method]?.test(path)) return responseError(404, "Recurso no disponible.");

  const headers = new Headers();
  for (const name of requestHeaders) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  try {
    const origin = new URL(process.env.API_INTERNAL_URL ?? "http://localhost:8080");
    const target = new URL(path + request.nextUrl.search, origin);
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(100_000)]),
    };
    if (request.body) {
      init.body = request.body;
      init.duplex = "half";
    }
    const upstream = await fetch(target, init);
    const outgoing = new Headers({ "Cache-Control": "no-store" });
    for (const name of responseHeaders) {
      const value = upstream.headers.get(name);
      if (value !== null) outgoing.set(name, value);
    }
    for (const cookie of upstream.headers.getSetCookie()) outgoing.append("Set-Cookie", cookie);
    return new Response(upstream.body, { status: upstream.status, headers: outgoing });
  } catch {
    return responseError(503, "Servicio clínico no disponible.");
  }
}

export { proxy as GET, proxy as POST, proxy as PATCH };
