import { bundleContent, contentToSheet, fetchGoogleSheet, readXlsx, SheetFetchError, writeXlsx, XlsxError, type Workbook } from "@moonbridge/content/sheet";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { LiveContent } from "./live.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_SHEET_BYTES = 10 * 1024 * 1024;

export interface SheetDeps {
  live: LiveContent;
  requireTeacher: preHandlerAsyncHookHandler;
  /** Who is signed in, for the record of who published. */
  accountId: (req: FastifyRequest) => string;
  fetch?: typeof fetch;
}

/**
 * The teacher's side of the content sheet: download the live content as a sheet, check an edited
 * sheet (a Google Sheets link or an .xlsx file) and publish it. Ilya is not needed for any of it.
 */
export async function sheetRoutes(app: FastifyInstance, d: SheetDeps): Promise<void> {
  const state = () => {
    const b = d.live.bundle;
    const v = d.live.version;
    return {
      content_hash: b.content_hash,
      units: b.modules.length,
      tasks: Object.keys(b.tasks).length,
      episodes: b.moonbridge?.episodes.length ?? 0,
      editable: d.live.editable,
      published: v ? { at: v.publishedAt.toISOString(), by: v.publisherName, source: v.source } : null,
    };
  };

  app.get("/school/content", { preHandler: d.requireTeacher }, async () => state());

  app.get("/school/content/sheet", { preHandler: d.requireTeacher }, async (_req, reply) => {
    const { book, layout } = contentToSheet(bundleContent(d.live.bundle));
    return reply
      .type(XLSX)
      .header("Content-Disposition", 'attachment; filename="moonbridge-content.xlsx"')
      .header("Cache-Control", "no-store")
      .send(Buffer.from(writeXlsx(book, layout)));
  });

  await app.register(async (sheets) => {
    sheets.addContentTypeParser([XLSX, "application/octet-stream"], { parseAs: "buffer", bodyLimit: MAX_SHEET_BYTES }, (_req, body, done) => done(null, body));

    /** The sheet from the request: an uploaded .xlsx, or { url } of a Google Sheet. */
    const workbook = async (req: FastifyRequest, reply: FastifyReply): Promise<{ book: Workbook; source: string } | undefined> => {
      try {
        if (Buffer.isBuffer(req.body)) {
          const name = String((req.query as { name?: string }).name ?? "таблица.xlsx").slice(0, 120);
          return { book: readXlsx(req.body), source: name };
        }
        const url = (req.body as { url?: unknown } | undefined)?.url;
        if (typeof url !== "string" || !url.trim()) {
          reply.code(400).send({ error: "sheet", message: "Вставьте ссылку на Google Таблицу или загрузите файл .xlsx" });
          return undefined;
        }
        return { book: readXlsx(await fetchGoogleSheet(url, d.fetch)), source: url.trim() };
      } catch (e) {
        if (e instanceof SheetFetchError || e instanceof XlsxError) {
          reply.code(422).send({ error: "sheet", message: e.message });
          return undefined;
        }
        throw e;
      }
    };

    sheets.post("/school/content/check", { preHandler: d.requireTeacher }, async (req, reply) => {
      const input = await workbook(req, reply);
      if (!input) return;
      const { ok, issues, summary } = d.live.check(input.book);
      return { ok, issues, summary: summary ?? null };
    });

    sheets.post("/school/content/publish", { preHandler: d.requireTeacher }, async (req, reply) => {
      if (!d.live.editable) return reply.code(409).send({ error: "sheet", message: "На этом сервере контент из таблицы не публикуется" });
      const input = await workbook(req, reply);
      if (!input) return;
      const check = d.live.check(input.book);
      if (!check.ok) return reply.code(422).send({ ok: false, issues: check.issues, summary: check.summary ?? null });
      await d.live.publish(check, { source: input.source, publishedBy: d.accountId(req) });
      req.log.info({ content_hash: d.live.bundle.content_hash, source: input.source }, "content published from the sheet");
      return { ok: true, issues: check.issues, summary: check.summary ?? null, content: state() };
    });
  });
}
