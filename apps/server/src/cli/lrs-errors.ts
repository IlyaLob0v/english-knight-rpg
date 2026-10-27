// Wrong answers on one concept from the LRS, e.g. the week's past_simple.irregular errors:
//   pnpm lrs:errors past_simple.irregular            (last 7 days)
//   pnpm lrs:errors past_simple.irregular --days 30 --player player_ab12
// Reads LRS_ENDPOINT / LRS_KEY / LRS_SECRET / XAPI_BASE_IRI like the gateway.
import { parseArgs } from "node:util";
import { conceptErrors, XapiProfile, LrsClient } from "@moonbridge/xapi";
import { loadConfig } from "../config.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { days: { type: "string", default: "7" }, player: { type: "string" }, json: { type: "boolean", default: false } },
});
const conceptId = positionals[0];
if (!conceptId) {
  console.error("usage: pnpm lrs:errors <concept_id> [--days 7] [--player <player_id>] [--json]");
  process.exit(2);
}
const config = loadConfig();
if (!config.lrs) {
  console.error("LRS_ENDPOINT, LRS_KEY and LRS_SECRET are required (docker/state/gateway.env has them for the local stack)");
  process.exit(2);
}

const since = new Date(Date.now() - Number(values.days) * 24 * 3600 * 1000);
const errors = await conceptErrors(new LrsClient(config.lrs), new XapiProfile(config.xapiBaseIri), conceptId, {
  since,
  ...(values.player ? { playerId: values.player } : {}),
});

if (values.json) {
  console.log(JSON.stringify(errors, null, 2));
} else {
  console.log(`${errors.length} wrong answers on ${conceptId} since ${since.toISOString()}`);
  const byType = new Map<string, number>();
  for (const e of errors) byType.set(e.errorType, (byType.get(e.errorType) ?? 0) + 1);
  for (const [type, n] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`  ${type}: ${n}`);
  console.table(errors.map((e) => ({ when: e.timestamp, player: e.playerId, task: e.taskId, answer: e.response, correct: e.correctForm ?? "", type: e.errorType })));
}
