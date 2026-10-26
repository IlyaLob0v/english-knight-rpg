import { validateContent, type ContentBundle } from "@knight/content";
import { buildBundle, loadContentDir } from "@knight/content/node";

const CONTENT_DIR = new URL("../../../content", import.meta.url).pathname;

export async function loadBundle(): Promise<ContentBundle> {
  const { source } = await loadContentDir(CONTENT_DIR);
  const result = validateContent(source);
  if (!result.content) throw new Error(JSON.stringify(result.issues, null, 2));
  return buildBundle(result.content);
}
