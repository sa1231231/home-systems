import { describe, expect, it } from "vitest";
import request from "supertest";
import { makeTestApp, mountViews } from "../../tests/helpers/test-app.js";
import { makeAuthRouter } from "./routes-auth.js";

const SECRET = "x".repeat(32);
const PASSWORD = "correct-horse-battery-staple";

function buildApp() {
  const app = makeTestApp();
  mountViews(app);
  app.use("/ui", makeAuthRouter({ password: PASSWORD, secret: SECRET, secure: false }));
  return app;
}

describe("routes-auth", () => {
  describe("GET /ui/login", () => {
    it("renders the login form with no error by default", async () => {
      const res = await request(buildApp()).get("/ui/login");
      expect(res.status).toBe(200);
      expect(res.text).toContain("<form");
      expect(res.text.toLowerCase()).toContain("password");
    });

    it("preserves a same-origin ?next param", async () => {
      const res = await request(buildApp()).get("/ui/login?next=/ui/gmail");
      expect(res.text).toContain("/ui/gmail");
    });

    it("rejects an external ?next param and falls back to /ui", async () => {
      const res = await request(buildApp()).get("/ui/login?next=https://evil.example/");
      expect(res.text).not.toContain("evil.example");
      expect(res.text).toContain('name="next" value="/ui"');
    });

    it("rejects a protocol-relative ?next param", async () => {
      const res = await request(buildApp()).get("/ui/login?next=//evil.example/");
      expect(res.text).toContain('name="next" value="/ui"');
    });
  });

  describe("POST /ui/login", () => {
    it("returns 401 with error message on wrong password", async () => {
      const res = await request(buildApp())
        .post("/ui/login")
        .type("form")
        .send({ password: "nope" });
      expect(res.status).toBe(401);
      expect(res.text).toContain("Incorrect password");
    });

    it("returns 401 on empty password without leaking equality timing", async () => {
      const res = await request(buildApp()).post("/ui/login").type("form").send({ password: "" });
      expect(res.status).toBe(401);
    });

    it("returns 302 + Set-Cookie + redirects to /ui by default on correct password", async () => {
      const res = await request(buildApp())
        .post("/ui/login")
        .type("form")
        .send({ password: PASSWORD });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/ui");
      expect(res.headers["set-cookie"]?.[0]).toMatch(/HttpOnly/);
      expect(res.headers["set-cookie"]?.[0]).toMatch(/SameSite=/i);
    });

    it("redirects to the same-origin ?next on success", async () => {
      const res = await request(buildApp())
        .post("/ui/login")
        .type("form")
        .send({ password: PASSWORD, next: "/ui/gmail" });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/ui/gmail");
    });

    it("falls back to /ui when ?next is external", async () => {
      const res = await request(buildApp())
        .post("/ui/login")
        .type("form")
        .send({ password: PASSWORD, next: "https://evil/" });
      expect(res.headers.location).toBe("/ui");
    });
  });

  describe("POST /ui/logout", () => {
    it("clears the cookie and redirects to /ui/login", async () => {
      const res = await request(buildApp()).post("/ui/logout");
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/ui/login");
      // A clear-cookie header sets Max-Age=0 or an expired Expires.
      const cookie = res.headers["set-cookie"]?.[0] ?? "";
      expect(cookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    });
  });
});
