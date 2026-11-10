import type { NextFunction, Request, RequestHandler, Response } from "express";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res)
      .then((body) => {
        if (!res.headersSent) res.json(body ?? { ok: true });
      })
      .catch(next);
  };

// Consistent error shape. Internal details go to the server log, never to the client.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  console.error("[api] unhandled error:", err instanceof Error ? err.message : "unknown");
  res.status(500).json({ error: { code: "server_error", message: "Something went wrong. Please try again." } });
}
