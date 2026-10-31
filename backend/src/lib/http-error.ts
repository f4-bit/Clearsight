export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);
export const forbidden = (message = "Forbidden") => new HttpError(403, "forbidden", message);
export const unauthorized = (message = "Invalid or missing token") =>
  new HttpError(401, "unauthorized", message);
export const unprocessable = (message: string) => new HttpError(422, "validation_error", message);
