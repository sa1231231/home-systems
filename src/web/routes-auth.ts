import { Router } from "express";
import { timingSafeEqual } from "crypto";
import { buildClearCookieHeader, buildSetCookieHeader } from "./auth.js";

export type AuthRouterOptions = {
  password: string;
  secret: string;
  secure: boolean;
};

function safeStringEqual(a: string, b: string): boolean {
  // Equalize length to avoid early-exit timing leaks.
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  const len = Math.max(aBuf.length, bBuf.length);
  const aPad = Buffer.alloc(len);
  const bPad = Buffer.alloc(len);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  const eq = timingSafeEqual(aPad, bPad);
  return eq && aBuf.length === bBuf.length;
}

function sanitizeNext(value: unknown): string {
  if (typeof value !== "string") return "/ui";
  // Only allow same-origin redirects: must start with "/" and not "//"
  if (!value.startsWith("/") || value.startsWith("//")) return "/ui";
  return value;
}

export function makeAuthRouter(opts: AuthRouterOptions): Router {
  const router = Router();

  router.get("/login", (req, res) => {
    res.render("login", { next: sanitizeNext(req.query.next), error: null });
  });

  router.post("/login", (req, res) => {
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const next = sanitizeNext(req.body?.next);
    if (!password || !safeStringEqual(password, opts.password)) {
      res.status(401).render("login", { next, error: "Incorrect password" });
      return;
    }
    res.setHeader("Set-Cookie", buildSetCookieHeader({ secret: opts.secret, secure: opts.secure }));
    res.redirect(302, next);
  });

  router.post("/logout", (_req, res) => {
    res.setHeader("Set-Cookie", buildClearCookieHeader({ secure: opts.secure }));
    res.redirect(302, "/ui/login");
  });

  return router;
}
