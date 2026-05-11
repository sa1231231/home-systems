import type { Response, Router as ExpressRouter } from "express";
import { Router } from "express";
import { and, desc, gte, like } from "drizzle-orm";
import { db } from "../db/client.js";
import { changelog } from "../db/schema.js";
import { newSessionId } from "../changelog/index.js";
import { windowStartFor24h } from "../api/changes.js";
import {
  hasTrelloCreds,
  MissingTrelloCredsError,
  requireTrelloCreds,
} from "../integrations/trello/auth.js";
import { makeTrelloClient, type TrelloCard } from "../integrations/trello/client.js";
import { runTrelloReorderOnce, type TrelloReorderResult } from "../sync/trello-runner.js";
import {
  bucketize,
  toLocalDate,
  type CardForOrdering,
  type ReorderContext,
} from "../sync/trello-reorder.js";

const BUCKET_NAMES: Record<number, string> = {
  1: "due",
  2: "daily",
  3: "weekdays",
  4: "weekends",
  5: "other",
};

export type CardView = {
  id: string;
  name: string;
  pos: number;
  dueLocal: string | null;
  labels: { name: string }[];
  bucket: 1 | 2 | 3 | 4 | 5;
};

export function makeTrelloUiRouter(): ExpressRouter {
  const router = Router();

  router.get("/", async (req, res) => {
    if (!hasTrelloCreds()) {
      renderEmpty(res, { notConfigured: true });
      return;
    }
    try {
      const result = await runOnce(req.sessionId, true);
      await render(res, { result, flash: null });
    } catch (err) {
      renderError(res, err);
    }
  });

  router.post("/reorder", async (req, res) => {
    if (!hasTrelloCreds()) {
      res.status(503).send("trello credentials not configured");
      return;
    }
    try {
      const result = await runOnce(req.sessionId, false);
      const errs = result.errors.length;
      const msg = `Reorder: ${result.moved} moved, ${result.reordered} reordered, ${result.unchanged} unchanged${errs ? `, ${errs} errors` : ""}.`;
      await render(res, { result, flash: { kind: errs > 0 ? "err" : "ok", message: msg } });
    } catch (err) {
      renderError(res, err);
    }
  });

  return router;
}

async function runOnce(sessionId: string | undefined, dryRun: boolean): Promise<TrelloReorderResult> {
  const creds = requireTrelloCreds();
  const client = makeTrelloClient({ apiKey: creds.apiKey, token: creds.token });
  return runTrelloReorderOnce(client, creds, {
    dryRun,
    sessionId: sessionId ?? newSessionId(),
    caller: dryRun ? "ui:trello.preview" : "ui:trello.reorder",
  });
}

async function render(
  res: Response,
  args: { result: TrelloReorderResult; flash: { kind: "ok" | "err"; message: string } | null },
): Promise<void> {
  const creds = requireTrelloCreds();
  const client = makeTrelloClient({ apiKey: creds.apiKey, token: creds.token });
  const [waiting, todayCards] = await Promise.all([
    client.listCards(creds.waitingListId),
    client.listCards(creds.todayListId),
  ]);
  const ctx: ReorderContext = {
    today: args.result.today,
    tz: creds.tz,
    dailyLabel: creds.dailyLabel,
    weekdaysLabel: creds.weekdaysLabel,
    weekendsLabel: creds.weekendsLabel,
  };

  const incomingIds = new Set(args.result.ops.filter((o) => o.kind === "move").map((o) => o.cardId));
  const incomingView = waiting.filter((c) => incomingIds.has(c.id)).map((c) => toCardView(c, ctx));
  const todayView = todayCards.map((c) => toCardView(c, ctx)).sort((a, b) => a.pos - b.pos);

  const since = windowStartFor24h();
  const activity = await db
    .select()
    .from(changelog)
    .where(and(like(changelog.operation, "trello.%"), gte(changelog.createdAt, since)))
    .orderBy(desc(changelog.id))
    .limit(20);

  res.render("trello", {
    notConfigured: false,
    flash: args.flash,
    result: args.result,
    todayView,
    incomingView,
    activity,
    bucketNames: BUCKET_NAMES,
    tz: creds.tz,
  });
}

function renderEmpty(res: Response, opts: { notConfigured: boolean; flash?: { kind: "ok" | "err"; message: string } | null }): void {
  res.render("trello", {
    notConfigured: opts.notConfigured,
    flash: opts.flash ?? null,
    result: null,
    todayView: [],
    incomingView: [],
    activity: [],
    bucketNames: BUCKET_NAMES,
    tz: null,
  });
}

function renderError(res: Response, err: unknown): void {
  const status = err instanceof MissingTrelloCredsError ? 503 : 500;
  const message = err instanceof Error ? err.message : String(err);
  res.status(status);
  renderEmpty(res, {
    notConfigured: err instanceof MissingTrelloCredsError,
    flash: { kind: "err", message },
  });
}

function toCardView(raw: TrelloCard, ctx: ReorderContext): CardView {
  const ord: CardForOrdering = {
    id: raw.id,
    idList: raw.idList,
    pos: raw.pos,
    due: raw.due,
    labels: (raw.labels ?? []).map((l) => ({ name: l.name })),
  };
  return {
    id: raw.id,
    name: raw.name,
    pos: raw.pos,
    dueLocal: raw.due ? toLocalDate(raw.due, ctx.tz) : null,
    labels: ord.labels,
    bucket: bucketize(ord, ctx),
  };
}
