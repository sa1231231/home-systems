import express, { Router } from "express";
import { requireAuth } from "./auth.js";
import { makeAuthRouter } from "./routes-auth.js";
import { makeChangesUiRouter } from "./routes-changes.js";
import { makeContactsUiRouter } from "./routes-contacts.js";
import { makeGmailUiRouter } from "./routes-gmail.js";
import { makeReviewUiRouter } from "./routes-review.js";
import { makeRulesUiRouter } from "./routes-rules.js";
import { makeTrelloUiRouter } from "./routes-trello.js";

export type WebRouterOptions = {
  authEnabled: boolean;
  password: string;
  secret: string;
  secure: boolean;
};

const passthrough: express.RequestHandler = (_req, _res, next) => next();

export function makeWebRouter(opts: WebRouterOptions): Router {
  const router = Router();

  // Login/logout MUST NOT require auth.
  router.use(
    "/",
    makeAuthRouter({ password: opts.password, secret: opts.secret, secure: opts.secure }),
  );

  // Everything else under /ui requires a valid session cookie.
  const gate: express.RequestHandler = opts.authEnabled
    ? requireAuth({ secret: opts.secret, defaultMode: "html" })
    : passthrough;

  router.get("/", gate, (_req, res) => {
    res.redirect(302, "/ui/changes");
  });

  router.use("/changes", gate, makeChangesUiRouter());
  router.use("/gmail", gate, makeGmailUiRouter());
  router.use("/contacts", gate, makeContactsUiRouter());
  router.use("/trello", gate, makeTrelloUiRouter());
  router.use("/needs-review", gate, makeReviewUiRouter());
  router.use("/rules", gate, makeRulesUiRouter());

  return router;
}
