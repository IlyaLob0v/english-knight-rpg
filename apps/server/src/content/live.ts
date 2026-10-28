import { validateContent, type ContentBundle, type ContentSource } from "@moonbridge/content";
import { buildBundle } from "@moonbridge/content/node";
import { bundleContent, checkSheet, withSheet, type SheetCheck, type Workbook } from "@moonbridge/content/sheet";
import type { ContentVersion, ContentVersions } from "./versions.js";

export interface SheetSummary {
  units: { id: string; title: string; tasks: number }[];
  tasks: number;
  episodes: number;
  added: string[];
  changed: string[];
  removed: string[];
}

/**
 * The content the gateway serves. It starts as the repository's content folder; a sheet the
 * teacher publishes replaces the course's units, tasks, episodes and places, and stays live
 * across restarts. Taxonomy, characters and daily guests always come from the repository.
 */
export class LiveContent {
  bundle: ContentBundle;
  version: ContentVersion | undefined;

  constructor(
    bundle: ContentBundle,
    private readonly base?: ContentSource,
    private readonly versions?: ContentVersions,
  ) {
    this.bundle = bundle;
  }

  /** Applies the newest published sheet. A sheet that no longer fits the repository's content is skipped, never half-applied. */
  async restore(log: (message: string) => void = () => undefined): Promise<void> {
    if (!this.base || !this.versions) return;
    const latest = await this.versions.latest();
    if (!latest) return;
    const result = validateContent(withSheet(this.base, latest.sheet));
    if (!result.ok || !result.content) {
      log(`published content #${latest.versionId} does not fit the repository's content any more; serving the repository's: ${result.issues.map((i) => `${i.file}: ${i.message}`).join("; ")}`);
      return;
    }
    this.bundle = buildBundle(result.content);
    this.version = latest;
  }

  /** Can the teacher publish from the sheet here: needs the repository's content and somewhere to keep versions. */
  get editable(): boolean {
    return Boolean(this.base && this.versions);
  }

  check(book: Workbook): SheetCheck & { summary?: SheetSummary } {
    if (!this.base) return { ok: false, issues: [{ severity: "error", where: "", message: "на этом сервере контент из таблицы не публикуется" }] };
    const live = bundleContent(this.bundle);
    const result = checkSheet(book, this.base, { modules: live.modules, tasks: live.taskSets.flatMap((s) => s.tasks) });
    if (!result.sheet) return result;
    const before = new Map(this.bundle.modules.map((m) => [m.module_id, m]));
    const after = new Set(result.sheet.modules.map((m) => m.module_id));
    const summary: SheetSummary = {
      units: result.sheet.modules.map((m) => ({ id: m.module_id, title: m.title.ru, tasks: m.tasks.length })),
      tasks: result.sheet.taskSets.reduce((n, s) => n + s.tasks.length, 0),
      episodes: result.sheet.episodes.length,
      added: result.sheet.modules.filter((m) => !before.has(m.module_id)).map((m) => m.module_id),
      changed: result.sheet.modules.filter((m) => before.has(m.module_id) && before.get(m.module_id)!.version !== m.version).map((m) => m.module_id),
      removed: [...before.keys()].filter((id) => !after.has(id)),
    };
    return { ...result, summary };
  }

  /** Makes a checked sheet live: kept first, then served. */
  async publish(check: SheetCheck, meta: { source: string; publishedBy: string | null }): Promise<ContentVersion> {
    if (!check.ok || !check.sheet || !check.content || !this.versions) throw new Error("only a valid sheet is published");
    const bundle = buildBundle(check.content);
    const version = await this.versions.publish({ contentHash: bundle.content_hash, sheet: check.sheet, ...meta });
    this.bundle = bundle;
    this.version = version;
    return version;
  }
}
