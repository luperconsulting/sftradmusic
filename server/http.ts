import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const notConfigured = (what: string) =>
  new ApiError(503, "integration_not_configured", `${what} is not configured yet.`);
export const forbidden = (message = "You don't have access to this.") => new ApiError(403, "forbidden", message);
export const notFound = (message = "Not found.") => new ApiError(404, "not_found", message);

export const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res)
      .then((body) => {
        if (!res.headersSent) res.json(body ?? { ok: true });
      })
      .catch(next);
  };

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw new ApiError(400, "invalid_input", "Some of the details provided aren't valid.");
  return result.data;
}

// Consistent error shape. Internal details go to the server log, never to the client.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  console.error("[api] unhandled error:", err instanceof Error ? err.message : "unknown");
  res.status(500).json({ error: { code: "server_error", message: "Something went wrong. Please try again." } });
}

export const uuid = z.string().uuid();
