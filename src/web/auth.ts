import { createHmac, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";

export const SESSION_COOKIE_NAME = "hs_session";
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionPayload = {
  iat: number;
  exp: number;
};

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function b64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

function hmac(secret: string, payload: string): string {
  return b64urlEncode(createHmac("sha256", secret).update(payload).digest());
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return timingSafeEqual(ab, bb);
}

export function signSession(
  secret: string,
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
  now: number = Date.now(),
): string {
  const payload: SessionPayload = { iat: now, exp: now + ttlMs };
  const encoded = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const mac = hmac(secret, encoded);
  return `${encoded}.${mac}`;
}

export function verifySession(
  secret: string,
  cookie: string,
  now: number = Date.now(),
): SessionPayload | null {
  if (typeof cookie !== "string") return null;
  const dot = cookie.indexOf(".");
  if (dot <= 0 || dot === cookie.length - 1) return null;
  const encoded = cookie.slice(0, dot);
  const givenMac = cookie.slice(dot + 1);
  const expectedMac = hmac(secret, encoded);
  if (!safeEqual(givenMac, expectedMac)) return null;
  let payload: SessionPayload;
  try {
    const parsed = JSON.parse(b64urlDecode(encoded).toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    payload = parsed as SessionPayload;
  } catch {
    return null;
  }
  if (payload.exp <= now) return null;
  return payload;
}

/** Parse the named cookie out of an HTTP Cookie header. */
export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === name) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return undefined;
}

export type SessionCookieOptions = {
  secret: string;
  ttlMs?: number;
  secure?: boolean;
  domain?: string;
  path?: string;
};

export function buildSetCookieHeader(opts: SessionCookieOptions, now: number = Date.now()): string {
  const ttl = opts.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const value = signSession(opts.secret, ttl, now);
  const parts = [
    `${SESSION_COOKIE_NAME}=${value}`,
    `Max-Age=${Math.floor(ttl / 1000)}`,
    `Path=${opts.path ?? "/"}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  return parts.join("; ");
}

export function buildClearCookieHeader(opts: { path?: string; secure?: boolean } = {}): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Max-Age=0",
    `Path=${opts.path ?? "/"}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export type RequireAuthOptions = {
  /** HMAC secret. Required. */
  secret: string;
  /** When the request prefers HTML, redirect to this path on auth failure. */
  loginPath?: string;
  /** Behavior when neither HTML nor JSON is preferred. */
  defaultMode?: "html" | "json";
};

function prefersHtml(req: Request): boolean {
  const accept = req.headers.accept ?? "";
  if (accept.includes("text/html")) return true;
  if (accept.includes("application/json")) return false;
  return false;
}

/** Express middleware that gates the request behind a valid signed session cookie. */
export function requireAuth(opts: RequireAuthOptions) {
  const loginPath = opts.loginPath ?? "/ui/login";
  const defaultMode = opts.defaultMode ?? "json";
  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const cookie = parseCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    const payload = cookie ? verifySession(opts.secret, cookie) : null;
    if (payload) {
      next();
      return;
    }
    const wantsHtml = prefersHtml(req) || (defaultMode === "html" && !req.headers.accept);
    if (wantsHtml) {
      const next = encodeURIComponent(req.originalUrl || req.url);
      res.redirect(302, `${loginPath}?next=${next}`);
      return;
    }
    res.status(401).json({ ok: false, error: "authentication required" });
  };
}
