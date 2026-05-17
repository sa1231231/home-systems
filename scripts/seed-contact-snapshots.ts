/**
 * One-off: seed the contact_snapshots baseline from current Google Contacts.
 *
 * After this, the next sync sees Google == baseline for every contact, so it
 * proposes nothing and any pre-existing sheet/Google divergence is preserved
 * as a user edit (the safe default). Run AFTER deploying the 3-way-compare
 * code (the contact_snapshots table is created by migration 0011 on boot).
 *
 *   npx tsx scripts/seed-contact-snapshots.ts            # dry run
 *   npx tsx scripts/seed-contact-snapshots.ts --apply    # write
 *
 * Idempotent: only contacts that don't already have a snapshot are seeded.
 */
import "dotenv/config";
import { getOAuthClient, requireGoogleCreds } from "../src/integrations/google/oauth.js";
import { listAllConnections } from "../src/integrations/google/people.js";
import { personToIdentity } from "../src/sync/contacts.js";
import { loadSnapshots, writeSnapshots } from "../src/sync/contact-snapshots.js";
import { pool } from "../src/db/client.js";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  requireGoogleCreds();

  const people = (await listAllConnections(getOAuthClient())).filter((p) => p.resource_name);
  const existing = await loadSnapshots(people.map((p) => p.resource_name));
  const toSeed = people.filter((p) => !existing.has(p.resource_name));

  console.log(
    `Google contacts: ${people.length}; already have a snapshot: ${existing.size}; ` +
      `to seed: ${toSeed.length}`,
  );
  console.log(apply ? "MODE: apply" : "MODE: dry run (pass --apply to write)");

  if (apply && toSeed.length > 0) {
    await writeSnapshots(
      toSeed.map((p) => ({ resourceName: p.resource_name, fields: personToIdentity(p) })),
    );
    console.log(`✓ Seeded ${toSeed.length} snapshot(s).`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("failed:", err);
  process.exit(1);
});
