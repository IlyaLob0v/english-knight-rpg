import type { SheetContent } from "@moonbridge/content/sheet";
import type { Sql } from "../db/sql.js";

export interface ContentVersion {
  versionId: number;
  contentHash: string;
  sheet: SheetContent;
  source: string;
  publishedBy: string | null;
  publisherName: string | null;
  publishedAt: Date;
}

interface Row {
  version_id: string | number;
  content_hash: string;
  sheet: SheetContent;
  source: string;
  published_by: string | null;
  publisher_name: string | null;
  published_at: Date;
}

const version = (r: Row): ContentVersion => ({
  versionId: Number(r.version_id),
  contentHash: r.content_hash,
  sheet: r.sheet,
  source: r.source,
  publishedBy: r.published_by,
  publisherName: r.publisher_name,
  publishedAt: r.published_at,
});

/** The history of content published from the sheet; the newest one is live. */
export class ContentVersions {
  constructor(private readonly sql: Sql) {}

  private async one(where: string, params: unknown[] = []): Promise<ContentVersion | undefined> {
    const { rows } = await this.sql.query<Row>(
      `SELECT v.*, a.name AS publisher_name FROM content_versions v LEFT JOIN accounts a ON a.account_id = v.published_by
        ${where} ORDER BY v.version_id DESC LIMIT 1`,
      params,
    );
    return rows[0] && version(rows[0]);
  }

  latest(): Promise<ContentVersion | undefined> {
    return this.one("");
  }

  async publish(v: { contentHash: string; sheet: SheetContent; source: string; publishedBy: string | null; at?: Date }): Promise<ContentVersion> {
    const { rows } = await this.sql.query<{ version_id: string }>(
      "INSERT INTO content_versions (content_hash, sheet, source, published_by, published_at) VALUES ($1, $2, $3, $4, $5) RETURNING version_id",
      [v.contentHash, JSON.stringify(v.sheet), v.source, v.publishedBy, v.at ?? new Date()],
    );
    return (await this.one("WHERE v.version_id = $1", [rows[0]!.version_id]))!;
  }
}
