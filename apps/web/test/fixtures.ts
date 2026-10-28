import { validateContent, type ContentBundle } from "@moonbridge/content";
import { buildBundle, loadContentDir } from "@moonbridge/content/node";

/** The frozen test course: three units, the reception and the Night Café. */
export const FIXTURE_DIR = new URL("../../../packages/content/test/fixtures/content", import.meta.url).pathname;

export async function loadBundle(dir = FIXTURE_DIR): Promise<ContentBundle> {
  const { source } = await loadContentDir(dir);
  const result = validateContent(source);
  if (!result.content) throw new Error(JSON.stringify(result.issues, null, 2));
  return buildBundle(result.content);
}
