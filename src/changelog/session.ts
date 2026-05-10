import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      sessionId: string;
    }
  }
}

export function sessionIdMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.sessionId = randomUUID();
    next();
  };
}

export function newSessionId(): string {
  return randomUUID();
}
