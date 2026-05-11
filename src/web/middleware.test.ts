import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, requireAuth, signSession } from "./auth.js";

const SECRET = "test-secret-with-enough-entropy-aaaa";

function makeApp() {
  const app = express();
  app.use("/protected", requireAuth({ secret: SECRET }), (_req, res) => {
    res.json({ ok: true });
  });
  app.use("/page", requireAuth({ secret: SECRET, defaultMode: "html" }), (_req, res) => {
    res.send("<h1>secret</h1>");
  });
  return app;
}

describe("requireAuth middleware", () => {
  it("rejects JSON requests without a session as 401", async () => {
    const app = makeApp();
    const r = await request(app).get("/protected").set("Accept", "application/json");
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ ok: false, error: "authentication required" });
  });

  it("redirects HTML requests without a session to /ui/login with next=", async () => {
    const app = makeApp();
    const r = await request(app).get("/page?foo=1").set("Accept", "text/html");
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(`/ui/login?next=${encodeURIComponent("/page?foo=1")}`);
  });

  it("admits requests carrying a valid session cookie", async () => {
    const app = makeApp();
    const cookie = signSession(SECRET, 60_000);
    const r = await request(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${cookie}`)
      .set("Accept", "application/json");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it("rejects requests with a tampered session cookie", async () => {
    const app = makeApp();
    const cookie = signSession(SECRET, 60_000);
    const dot = cookie.indexOf(".");
    const tampered = `${cookie.slice(0, dot + 1)}${"A".repeat(43)}`;
    const r = await request(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${tampered}`)
      .set("Accept", "application/json");
    expect(r.status).toBe(401);
  });

  it("rejects requests with an expired session cookie", async () => {
    const app = makeApp();
    // Expired cookie: signed 2 hours ago with 1h TTL.
    const cookie = signSession(SECRET, 60_000, Date.now() - 2 * 60 * 60 * 1000);
    const r = await request(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${cookie}`)
      .set("Accept", "application/json");
    expect(r.status).toBe(401);
  });

  it("honors a custom loginPath", async () => {
    const app = express();
    app.use(
      "/page",
      requireAuth({ secret: SECRET, loginPath: "/admin/login", defaultMode: "html" }),
      (_req, res) => res.send("ok"),
    );
    const r = await request(app).get("/page").set("Accept", "text/html");
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/^\/admin\/login\?next=/);
  });
});
