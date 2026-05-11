import "dotenv/config";
import { makeTrelloClient } from "../src/integrations/trello/client.js";
import { requireTrelloAuth } from "../src/integrations/trello/auth.js";

async function main() {
  let auth;
  try {
    auth = requireTrelloAuth();
  } catch (err) {
    console.error(
      "TRELLO_API_KEY and TRELLO_TOKEN must be set in your environment.\n" +
        "  1. API key: https://trello.com/app-key (the developer key, public)\n" +
        "  2. Token: follow the 'Token' link on that page; authorize the app,\n" +
        "     copy the token. Treat it like a password.\n" +
        "  3. Put both in .env.local (TRELLO_API_KEY=..., TRELLO_TOKEN=...), then\n" +
        "     re-run `npm run trello:setup`.",
    );
    process.exit(1);
  }

  const client = makeTrelloClient(auth);
  console.log("Fetching your Trello workspace...\n");
  const boards = await client.listMemberBoards();
  if (boards.length === 0) {
    console.error("No open boards found on your account.");
    process.exit(1);
  }

  for (const board of boards) {
    console.log(`board "${board.name}"`);
    console.log(`  TRELLO_BOARD_ID=${board.id}`);
    const [lists, labels] = await Promise.all([
      client.getLists(board.id),
      client.getLabels(board.id),
    ]);
    if (lists.length > 0) {
      console.log("  lists:");
      for (const list of lists) {
        console.log(`    "${list.name}"  →  ${list.id}`);
      }
    }
    if (labels.length > 0) {
      console.log("  labels:");
      for (const label of labels) {
        const tag = label.name || "(unnamed)";
        console.log(`    ${tag.padEnd(20)} color=${label.color ?? "-"}  id=${label.id}`);
      }
    }
    console.log();
  }

  console.log(
    "Next: pick the board where your Waiting + Today-to-do lists live and copy the\n" +
      "matching IDs into your .env / Railway variables as:\n" +
      "  TRELLO_BOARD_ID=...\n" +
      "  TRELLO_WAITING_LIST_ID=...\n" +
      "  TRELLO_TODAY_LIST_ID=...\n" +
      "  TRELLO_DAILY_LABEL=daily       # (or whichever label name you use)\n" +
      "  TRELLO_WEEKDAYS_LABEL=weekdays\n" +
      "  TRELLO_WEEKENDS_LABEL=weekends",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
