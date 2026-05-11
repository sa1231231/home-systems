import express from "express";
import { sessionIdMiddleware } from "../../src/changelog/index.js";

export type TestAppOptions = {
  /**
   * If true, mount express.json() / express.urlencoded() and sessionIdMiddleware
   * before any routers (matches production index.ts). Default true.
   */
  parseBody?: boolean;
};

/**
 * Build a minimal express app for route tests. The caller mounts whatever
 * router(s) they want at the path of their choosing — keeps each route test
 * file scoped to the surface it covers.
 *
 * Example:
 *   const app = makeTestApp();
 *   app.set("view engine", "ejs");
 *   app.set("views", viewsPath);
 *   app.use("/ui/gmail", makeGmailUiRouter());
 *   const res = await request(app).get("/ui/gmail");
 */
export function makeTestApp(opts: TestAppOptions = {}): express.Express {
  const parseBody = opts.parseBody !== false;
  const app = express();
  if (parseBody) {
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(sessionIdMiddleware());
  }
  return app;
}

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the production EJS views. Mount this so render() resolves. */
export const VIEWS_PATH = path.resolve(__dirname, "../../src/web/views");

/**
 * Wire up EJS for a test app so `res.render('foo')` works.
 */
export function mountViews(app: express.Express): void {
  app.set("view engine", "ejs");
  app.set("views", VIEWS_PATH);
}
