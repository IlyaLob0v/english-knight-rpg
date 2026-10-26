import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Statement } from "./types.js";

// Structural checks for the xAPI 1.0.3 rules the game relies on. An LRS is the
// final authority; this catches our own bugs before a statement reaches the queue.
const languageMap = { type: "object", additionalProperties: { type: "string" } } as const;
const activity = {
  type: "object",
  required: ["id"],
  properties: {
    objectType: { const: "Activity" },
    id: { type: "string", format: "uri" },
    definition: {
      type: "object",
      properties: {
        type: { type: "string", format: "uri" },
        name: languageMap,
        description: languageMap,
        interactionType: {
          enum: ["true-false", "choice", "fill-in", "long-fill-in", "matching", "performance", "sequencing", "likert", "numeric", "other"],
        },
        correctResponsesPattern: { type: "array", items: { type: "string" } },
        extensions: { $ref: "#/$defs/extensions" },
      },
    },
  },
} as const;

const statementSchema = {
  type: "object",
  required: ["id", "actor", "verb", "object", "timestamp"],
  properties: {
    id: { type: "string", format: "uuid" },
    actor: {
      type: "object",
      required: ["account"],
      properties: {
        objectType: { const: "Agent" },
        account: {
          type: "object",
          required: ["homePage", "name"],
          additionalProperties: false,
          properties: { homePage: { type: "string", format: "uri" }, name: { type: "string", minLength: 1 } },
        },
        mbox: false,
        mbox_sha1sum: false,
        openid: false,
      },
    },
    verb: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", format: "uri" }, display: languageMap },
    },
    object: activity,
    result: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        completion: { type: "boolean" },
        response: { type: "string" },
        duration: { type: "string", pattern: "^P(?:\\d+Y)?(?:\\d+M)?(?:\\d+D)?(?:T(?:\\d+H)?(?:\\d+M)?(?:\\d+(?:\\.\\d+)?S)?)?$" },
        score: {
          type: "object",
          properties: {
            scaled: { type: "number", minimum: -1, maximum: 1 },
            raw: { type: "number" },
            min: { type: "number" },
            max: { type: "number" },
          },
        },
        extensions: { $ref: "#/$defs/extensions" },
      },
    },
    context: {
      type: "object",
      properties: {
        registration: { type: "string", format: "uuid" },
        contextActivities: {
          type: "object",
          additionalProperties: false,
          properties: {
            parent: { type: "array", items: activity },
            grouping: { type: "array", items: activity },
            category: { type: "array", items: activity },
            other: { type: "array", items: activity },
          },
        },
        platform: { type: "string" },
        language: { type: "string" },
        extensions: { $ref: "#/$defs/extensions" },
      },
    },
    timestamp: { type: "string", format: "date-time" },
  },
  $defs: {
    // Extension keys must be IRIs (we only emit ASCII IRIs, so the "uri" format applies).
    extensions: { type: "object", propertyNames: { format: "uri" } },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const check = ajv.compile(statementSchema);

export function validateStatement(s: unknown): { ok: true; statement: Statement } | { ok: false; errors: string[] } {
  if (check(s)) {
    const st = s as Statement;
    const r = st.result?.score;
    if (r && r.min !== undefined && r.max !== undefined && r.raw !== undefined && (r.raw < r.min || r.raw > r.max)) {
      return { ok: false, errors: ["/result/score/raw must be between min and max"] };
    }
    return { ok: true, statement: st };
  }
  return { ok: false, errors: (check.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`) };
}
