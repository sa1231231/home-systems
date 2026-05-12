/**
 * One-shot sheet cleanup for the dex_contacts switchover.
 *
 *   $ npx tsx scripts/contacts-cleanup-sheet.ts          # dry run, prints plan
 *   $ npx tsx scripts/contacts-cleanup-sheet.ts --apply  # actually execute
 *
 * What it does (when --apply):
 *   1) Deletes the obsolete "Contacts" tab from the spreadsheet (if present).
 *   2) Renames `dex_*` columns in dex_contacts to their non-dex names
 *      (dex_email → email, dex_groups → groups, etc.).
 *   3) Removes the legacy Dex columns the user explicitly doesn't want
 *      (LinkedIn enhance fields, iMessage/WhatsApp/Instagram interaction
 *      tracking, gmail/gcal/phone interaction logs, frequency/reminder
 *      cadence, social handles, Dex internal IDs, etc.).
 *
 * Reversible via the Sheets revision history. Idempotent — runs after the
 * first apply do nothing.
 */
import { google } from "googleapis";
import { getConfig } from "../src/config.js";
import { getOAuthClient, requireGoogleCreds } from "../src/integrations/google/oauth.js";
import {
  colLetter,
  deleteColumns,
  readContactsTab,
} from "../src/integrations/google/sheets.js";

const COLUMNS_TO_DROP = [
  // Original list (basic identity / social / state)
  "first_name",
  "last_name",
  "starred",
  "last_reminder",
  "last_reminder_at",
  "facebook",
  "twitter",
  "telegram",
  "is_archived",
  "birthday",
  "birthday_year",
  "year",
  "linkedin",
  "linkedin_url",
  "last_message",
  "imessage",
  "whatsapp",
  "google_calendar",
  "image_url",
  "location",
  // Extra Dex-imported columns the user wants gone
  "instagram",
  "tiktok",
  "youtube",
  "business_card_url",
  "linkedin_enhance_date",
  "linkedin_companies",
  "linkedin_education",
  "linkedin_last_message_at",
  "linkedin_message_link",
  "whatsapp_message_link",
  "whatsapp_last_message_at",
  "imessage_message_link",
  "imessage_last_message_at",
  "instagram_message_link",
  "instagram_last_message_at",
  "gmail_last_interaction_at",
  "gmail_last_interaction_subject",
  "gmail_last_interaction_provider",
  "gcal_last_interaction_at",
  "gcal_last_interaction_title",
  "gcal_last_interaction_provider",
  "phone_call_interaction_snippet",
  "phone_call_last_interaction_at",
  "web_search_summary",
  "frequency",
  "frequency_text",
  "next_reminder_at",
  "last_seen_at",
  "education",
  "id",
  "user_id",
];

/** Rename map: old header → new header. Run AFTER drops so indices stay
 *  stable through the delete phase. */
const COLUMNS_TO_RENAME: Record<string, string> = {
  dex_email: "email",
  dex_emails: "emails",
  dex_phone: "phone",
  dex_phones: "phones",
  dex_address: "address",
  dex_groups: "groups",
  dex_tags: "tags",
};

async function main() {
  const apply = process.argv.includes("--apply");
  const creds = requireGoogleCreds();
  const client = getOAuthClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const targetTab = getConfig().CONTACTS_TAB;

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: creds.sheetId,
    fields: "sheets.properties",
  });
  const allSheets = (meta.data.sheets ?? [])
    .map((s) => ({ id: s.properties?.sheetId, title: s.properties?.title }))
    .filter((s): s is { id: number; title: string } => typeof s.id === "number" && !!s.title);

  console.log(`Spreadsheet ${creds.sheetId}`);
  console.log(`Target tab: ${targetTab}`);
  console.log(`Mode: ${apply ? "APPLY" : "dry run (use --apply to execute)"}`);
  console.log();

  // 1. Delete the old "Contacts" tab if present
  const oldContacts = allSheets.find((s) => s.title === "Contacts");
  if (oldContacts) {
    console.log(`Will delete obsolete tab "Contacts" (sheetId=${oldContacts.id}).`);
    if (apply) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: creds.sheetId,
        requestBody: {
          requests: [{ deleteSheet: { sheetId: oldContacts.id } }],
        },
      });
      console.log(`  → deleted.`);
    }
  } else {
    console.log(`(No "Contacts" tab present — already cleaned.)`);
  }
  console.log();

  // 2. Drop unwanted columns from dex_contacts
  const dex = allSheets.find((s) => s.title === targetTab);
  if (!dex) {
    console.error(`ERROR: tab "${targetTab}" not found in spreadsheet.`);
    process.exit(1);
  }
  const tab = await readContactsTab(client, creds.sheetId, { tab: targetTab });
  const dropMatches: { name: string; index: number }[] = [];
  for (const name of COLUMNS_TO_DROP) {
    const i = tab.headers.indexOf(name);
    if (i !== -1) dropMatches.push({ name, index: i });
  }
  console.log(`Will drop ${dropMatches.length} column(s) from ${targetTab}:`);
  for (const m of dropMatches) console.log(`  - [${m.index}] ${m.name}`);
  console.log();

  if (apply && dropMatches.length > 0) {
    await deleteColumns(
      client,
      creds.sheetId,
      dex.id,
      dropMatches.map((m) => m.index),
    );
    console.log(`  → dropped ${dropMatches.length} columns.`);
    console.log();
  }

  // 3. Rename dex_* columns to non-dex names. Re-read headers after the
  //    delete so we have fresh indices.
  const refreshed = apply
    ? await readContactsTab(client, creds.sheetId, { tab: targetTab })
    : tab;
  const renamePlan: { oldName: string; newName: string; index: number }[] = [];
  for (const [oldName, newName] of Object.entries(COLUMNS_TO_RENAME)) {
    const i = refreshed.headers.indexOf(oldName);
    if (i === -1) continue;
    // If the new name is already present elsewhere, skip — manual merge needed.
    if (refreshed.headers.includes(newName)) {
      console.warn(
        `  ⚠ skipping rename ${oldName} → ${newName}: target column already exists.`,
      );
      continue;
    }
    renamePlan.push({ oldName, newName, index: i });
  }
  console.log(`Will rename ${renamePlan.length} column header(s):`);
  for (const r of renamePlan) {
    console.log(`  - [${r.index}] ${r.oldName} → ${r.newName}`);
  }
  console.log();

  if (apply && renamePlan.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: creds.sheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: renamePlan.map((r) => ({
          range: `${targetTab}!${colLetter(r.index)}1`,
          values: [[r.newName]],
        })),
      },
    });
    console.log(`  → renamed ${renamePlan.length} headers.`);
    console.log();
  }

  // 4. Show final keep list
  const finalTab = apply
    ? await readContactsTab(client, creds.sheetId, { tab: targetTab })
    : tab;
  const finalKept = finalTab.headers.filter(
    (h) => !dropMatches.some((m) => m.name === h),
  );
  const renameLookup = new Map(renamePlan.map((r) => [r.oldName, r.newName]));
  const projected = apply
    ? finalKept
    : finalKept.map((h) => renameLookup.get(h) ?? h);
  console.log(`Final dex_contacts column list (${projected.length}):`);
  for (const h of projected) console.log(`  - ${h}`);
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
