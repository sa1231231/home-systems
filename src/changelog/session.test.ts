import { describe, expect, it } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { newSessionId, sessionIdMiddleware } from "./session.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("newSessionId", () => {
  it("returns a UUID v4-shaped string", () => {
    const id = newSessionId();
    expect(id).toMatch(UUID_REGEX);
  });

  it("returns unique values on each call", () => {
    const ids = new Set(Array.from({ length: 20 }, () => newSessionId()));
    expect(ids.size).toBe(20);
  });
});

describe("sessionIdMiddleware", () => {
  it("assigns req.sessionId and calls next()", () => {
    const mw = sessionIdMiddleware();
    const req = {} as Request;
    let nextCalled = 0;
    const next: NextFunction = () => {
      nextCalled += 1;
    };
    mw(req, {} as Response, next);
    expect(req.sessionId).toMatch(UUID_REGEX);
    expect(nextCalled).toBe(1);
  });

  it("issues a fresh session id per request", () => {
    const mw = sessionIdMiddleware();
    const req1 = {} as Request;
    const req2 = {} as Request;
    const next: NextFunction = () => {};
    mw(req1, {} as Response, next);
    mw(req2, {} as Response, next);
    expect(req1.sessionId).not.toBe(req2.sessionId);
  });
});
