import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_TTL_MS,
  SESSION_COOKIE_NAME,
  buildClearCookieHeader,
  buildSetCookieHeader,
  parseCookie,
  signSession,
  verifySession,
} from "./auth.js";

const SECRET = "test-secret-with-enough-entropy-aaaa";

describe("signSession + verifySession", () => {
  it("round-trips a valid cookie", () => {
    const now = Date.UTC(2026, 4, 11, 12, 0, 0);
    const cookie = signSession(SECRET, 60_000, now);
    const payload = verifySession(SECRET, cookie, now + 1000);
    expect(payload).not.toBeNull();
    expect(payload!.iat).toBe(now);
    expect(payload!.exp).toBe(now + 60_000);
  });

  it("rejects a cookie signed with a different secret", () => {
    const now = Date.UTC(2026, 4, 11);
    const cookie = signSession(SECRET, 60_000, now);
    expect(verifySession("other-secret-xxxxxxxxxxxxxxxxxxxxxxxx", cookie, now)).toBeNull();
  });

  it("rejects a cookie with a tampered payload", () => {
    const now = Date.UTC(2026, 4, 11);
    const cookie = signSession(SECRET, 60_000, now);
    const dot = cookie.indexOf(".");
    const tamperedPayload = Buffer.from('{"iat":0,"exp":99999999999999}').toString("base64url");
    const tampered = `${tamperedPayload}.${cookie.slice(dot + 1)}`;
    expect(verifySession(SECRET, tampered, now)).toBeNull();
  });

  it("rejects a cookie with a tampered mac", () => {
    const now = Date.UTC(2026, 4, 11);
    const cookie = signSession(SECRET, 60_000, now);
    const dot = cookie.indexOf(".");
    const tampered = `${cookie.slice(0, dot + 1)}${"A".repeat(43)}`;
    expect(verifySession(SECRET, tampered, now)).toBeNull();
  });

  it("rejects an expired cookie", () => {
    const issuedAt = Date.UTC(2026, 4, 11);
    const cookie = signSession(SECRET, 60_000, issuedAt);
    expect(verifySession(SECRET, cookie, issuedAt + 60_001)).toBeNull();
    expect(verifySession(SECRET, cookie, issuedAt + 60_000)).toBeNull(); // exp boundary excluded
  });

  it("rejects malformed cookies", () => {
    const now = Date.now();
    expect(verifySession(SECRET, "", now)).toBeNull();
    expect(verifySession(SECRET, "no-dot", now)).toBeNull();
    expect(verifySession(SECRET, ".tail", now)).toBeNull();
    expect(verifySession(SECRET, "head.", now)).toBeNull();
    expect(verifySession(SECRET, "not-base64.also-not", now)).toBeNull();
  });
});

describe("parseCookie", () => {
  it("returns undefined for missing header", () => {
    expect(parseCookie(undefined, "x")).toBeUndefined();
    expect(parseCookie("", "x")).toBeUndefined();
  });

  it("extracts the named cookie", () => {
    const header = "a=1; hs_session=abc.def; foo=bar";
    expect(parseCookie(header, SESSION_COOKIE_NAME)).toBe("abc.def");
    expect(parseCookie(header, "foo")).toBe("bar");
    expect(parseCookie(header, "missing")).toBeUndefined();
  });

  it("url-decodes values", () => {
    expect(parseCookie("k=hello%20world", "k")).toBe("hello world");
  });

  it("handles cookies without leading space after semicolon", () => {
    expect(parseCookie("a=1;b=2", "b")).toBe("2");
  });
});

describe("buildSetCookieHeader", () => {
  it("includes HttpOnly, SameSite=Lax, and Max-Age", () => {
    const now = Date.UTC(2026, 4, 11);
    const header = buildSetCookieHeader({ secret: SECRET, ttlMs: 3600_000 }, now);
    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain("Max-Age=3600");
    expect(header).toContain("Path=/");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Secure");
  });

  it("adds Secure when configured", () => {
    const header = buildSetCookieHeader({ secret: SECRET, secure: true });
    expect(header).toContain("Secure");
  });

  it("defaults Max-Age to the session TTL", () => {
    const header = buildSetCookieHeader({ secret: SECRET });
    expect(header).toContain(`Max-Age=${Math.floor(DEFAULT_SESSION_TTL_MS / 1000)}`);
  });
});

describe("buildClearCookieHeader", () => {
  it("sets Max-Age=0 to clear the cookie", () => {
    const header = buildClearCookieHeader();
    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
  });
});
