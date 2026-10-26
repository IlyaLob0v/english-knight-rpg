const APOSTROPHES = /[‘’ʼ`´]/g;
const QUOTES = /[“”«»]/g;
const TRAILING_PUNCT = /[.!?;,]+$/;

/**
 * Normalizes an answer for comparison: apostrophes and quotes unified, whitespace
 * collapsed, trailing sentence punctuation dropped, lowercased unless case-sensitive.
 * Shared by the content validator and the learning engine so that both agree on
 * what "the same answer" means.
 */
export function normalizeAnswer(input: string, caseSensitive = false): string {
  let s = input.normalize("NFC").replace(APOSTROPHES, "'").replace(QUOTES, '"');
  s = s.replace(/\s+/g, " ").trim().replace(TRAILING_PUNCT, "").trim();
  s = s.replace(/\s+([,.!?;])/g, "$1");
  return caseSensitive ? s : s.toLowerCase();
}

/** Splits a sentence into word tokens the way order_words tasks compare them. */
export function tokenize(sentence: string): string[] {
  return normalizeAnswer(sentence).split(" ").filter(Boolean);
}
