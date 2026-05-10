import type { OAuth2Client } from "google-auth-library";
import { batchUpdateCells } from "../../integrations/google/sheets.js";
import { registry } from "../reversers.js";
import type { ChangelogRow } from "../types.js";

export type CellPlan = { range: string; value: string };

export class MalformedExternalTargetError extends Error {
  constructor(public readonly externalTarget: string) {
    super(`malformed external_target '${externalTarget}'`);
    this.name = "MalformedExternalTargetError";
  }
}

const PREFIX = "google.sheet:";

export type ParsedSheetTarget = { sheetId: string; range: string };

export function parseSheetTarget(externalTarget: string | null): ParsedSheetTarget {
  if (!externalTarget?.startsWith(PREFIX)) {
    throw new MalformedExternalTargetError(externalTarget ?? "");
  }
  const rest = externalTarget.slice(PREFIX.length);
  const sep = rest.indexOf("!");
  if (sep === -1) throw new MalformedExternalTargetError(externalTarget);
  const sheetId = rest.slice(0, sep);
  const range = rest.slice(sep + 1);
  if (!sheetId || !range) throw new MalformedExternalTargetError(externalTarget);
  return { sheetId, range };
}

export function planCsvReversal(entry: ChangelogRow, field: "groups" | "tags"): CellPlan {
  const { range } = parseSheetTarget(entry.externalTarget);
  const before = entry.beforeState[field];
  if (typeof before !== "string") {
    throw new Error(`changelog ${entry.id} missing before_state.${field}`);
  }
  return { range, value: before };
}

export function planBoolReversal(entry: ChangelogRow, field: "is_archived" | "starred"): CellPlan {
  const { range } = parseSheetTarget(entry.externalTarget);
  const before = entry.beforeState[field];
  if (typeof before !== "boolean") {
    throw new Error(`changelog ${entry.id} missing before_state.${field}`);
  }
  return { range, value: before ? "TRUE" : "FALSE" };
}

export function registerContactReversers(client: OAuth2Client): void {
  for (const field of ["groups", "tags"] as const) {
    registry.register(`contacts.add_csv.${field}`, async (entry) => {
      const { sheetId } = parseSheetTarget(entry.externalTarget);
      const plan = planCsvReversal(entry, field);
      await batchUpdateCells(client, sheetId, [plan]);
    });
    registry.register(`contacts.remove_csv.${field}`, async (entry) => {
      const { sheetId } = parseSheetTarget(entry.externalTarget);
      const plan = planCsvReversal(entry, field);
      await batchUpdateCells(client, sheetId, [plan]);
    });
  }
  for (const field of ["is_archived", "starred"] as const) {
    registry.register(`contacts.set_bool.${field}`, async (entry) => {
      const { sheetId } = parseSheetTarget(entry.externalTarget);
      const plan = planBoolReversal(entry, field);
      await batchUpdateCells(client, sheetId, [plan]);
    });
  }
}
