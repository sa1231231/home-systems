import { Router } from "express";
import { requireAuth } from "./auth.js";
import { makeAuthRouter } from "./routes-auth.js";

export type WebRouterOptions = {
  authEnabled: boolean;
  password: string;
  secret: string;
  secure: boolean;
};

export function makeWebRouter(opts: WebRouterOptions): Router {
  const router = Router();

  // Login/logout MUST NOT require auth.
  router.use(
    "/",
    makeAuthRouter({ password: opts.password, secret: opts.secret, secure: opts.secure }),
  );

  // Everything else under /ui requires a valid session cookie.
  const gate = opts.authEnabled
    ? requireAuth({ secret: opts.secret, defaultMode: "html" })
    : (_req: unknown, _res: unknown, next: () => void) => next();

  router.get("/", gate as never, (_req, res) => {
    res.redirect(302, "/ui/changes");
  });

  return router;
}
