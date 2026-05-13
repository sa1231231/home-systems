/**
 * One-shot: seed contact_groups from the distinct values currently in
 * dex_contacts.groups (CSV-split). Idempotent — upserts by name.
 *
 *   $ npx tsx scripts/seed-contact-groups.ts          # dry-run
 *   $ npx tsx scripts/seed-contact-groups.ts --apply  # execute
 */
import { getConfig } from "../src/config.js";
import { getOAuthClient, requireGoogleCreds } from "../src/integrations/google/oauth.js";
import { readContactsTab } from "../src/integrations/google/sheets.js";
import { listGroups, upsertGroup } from "../src/sync/contact-groups.js";

async function main() {
  const apply = process.argv.includes("--apply");
  const creds = requireGoogleCreds();
  const client = getOAuthClient();
  const tabName = getConfig().CONTACTS_TAB;

  const tab = await readContactsTab(client, creds.sheetId, { tab: tabName });
  const set = new Map<string, number>(); // name → row count
  for (const row of tab.rows) {
    const raw = row.record.groups || "";
    for (const piece of raw.split(",")) {
      const g = piece.trim();
      if (g) set.set(g, (set.get(g) ?? 0) + 1);
    }
  }
  const sorted = [...set.entries()].sort((a, b) => b[1] - a[1]);

  console.log(`Found ${sorted.length} distinct group(s) in ${tabName}.groups (sorted by usage):`);
  for (const [g, n] of sorted) console.log(`  ${String(n).padStart(5)}  ${g}`);
  console.log();

  if (!apply) {
    console.log("Dry-run only. Re-run with --apply to insert into contact_groups.");
    return;
  }

  let inserted = 0;
  let already = 0;
  for (const [name] of sorted) {
    const isNew = await upsertGroup(name);
    if (isNew) inserted++;
    else already++;
  }
  console.log(`Inserted ${inserted}, already existed ${already}.`);

  const after = await listGroups();
  console.log(`contact_groups now has ${after.length} active group(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
