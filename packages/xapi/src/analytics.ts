import { ADL_VERBS, type KnightProfile } from "./profile.js";
import type { LrsClient } from "./lrs-client.js";
import type { Statement } from "./types.js";

export interface ConceptError {
  statementId: string;
  playerId: string;
  taskId: string;
  response: string;
  /** Error type id from the taxonomy, e.g. grammar.overgeneralization; unclassified when the author did not foresee the answer. */
  errorType: string;
  correctForm?: string;
  timestamp: string;
}

/**
 * The wrong answers on one concept in a time window, straight from the LRS: the
 * concept rides in context.contextActivities.grouping of every `answered` statement,
 * so `related_activities` finds them whatever task asked about it.
 */
export async function conceptErrors(
  lrs: Pick<LrsClient, "query">,
  profile: KnightProfile,
  conceptId: string,
  window: { since: Date; until?: Date; playerId?: string },
): Promise<ConceptError[]> {
  const statements = await lrs.query({
    verb: ADL_VERBS.answered,
    activity: profile.concept(conceptId),
    related_activities: true,
    since: window.since.toISOString(),
    ...(window.until ? { until: window.until.toISOString() } : {}),
    ...(window.playerId ? { agent: { objectType: "Agent", account: { homePage: profile.accountHomePage, name: window.playerId } } } : {}),
    ascending: true,
  });
  const errorPrefix = `${profile.baseIri}/xapi/errors/`;
  return statements
    .filter((s) => s.result?.success === false)
    .map((s: Statement) => {
      const ext = s.result?.extensions ?? {};
      const errorIri = ext[profile.ext("error-type")];
      const correct = ext[profile.ext("correct-form")];
      return {
        statementId: s.id,
        playerId: s.actor.account.name,
        taskId: decodeURIComponent(s.object.id.split("/").pop() ?? ""),
        response: s.result?.response ?? "",
        errorType: typeof errorIri === "string" && errorIri.startsWith(errorPrefix) ? errorIri.slice(errorPrefix.length).split("/").map(decodeURIComponent).join(".") : "unclassified",
        ...(typeof correct === "string" ? { correctForm: correct } : {}),
        timestamp: s.timestamp ?? "",
      };
    });
}
