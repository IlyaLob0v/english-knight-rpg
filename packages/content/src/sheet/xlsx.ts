import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

// The smallest .xlsx reader and writer the content sheet needs: cell text by sheet, no formulas,
// no dates. Google Sheets ("Файл → Скачать → Microsoft Excel") and Excel both write this format.

/** Sheet name → rows → cell text. Empty cells are "". */
export type Workbook = Record<string, string[][]>;

export class XlsxError extends Error {}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
    return ENTITIES[e] ?? m;
  });
}

function escapeXml(s: string): string {
  // Control characters other than tab and newline are not allowed in XML 1.0.
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]!) : undefined;
}

/** All <t> texts inside a fragment, joined: plain and rich-text runs alike. Phonetic runs (<rPh>) are skipped. */
function texts(xml: string): string {
  let out = "";
  for (const m of xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += unescapeXml(m[1] ?? "");
  return out;
}

/** "B" → 1, "AA" → 26. */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? "") n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function columnName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Reads every sheet of an .xlsx file, in workbook order. */
export function readXlsx(data: Uint8Array): Workbook {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch {
    throw new XlsxError("это не файл Excel (.xlsx)");
  }
  const text = (path: string) => (files[path] ? strFromU8(files[path]) : undefined);
  const workbook = text("xl/workbook.xml");
  const rels = text("xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) throw new XlsxError("это не файл Excel (.xlsx)");

  const targets = new Map<string, string>();
  for (const [tag] of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const shared: string[] = [];
  for (const [, si] of (text("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(texts(si!));

  const book: Workbook = {};
  for (const [tag] of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(tag, "name");
    const path = targets.get(attr(tag, "r:id") ?? "");
    const xml = path ? text(path) : undefined;
    if (!name || !xml) continue;
    const rows: string[][] = [];
    for (const [, rowTag, body] of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = Number(attr(rowTag!, "r") ?? rows.length + 1) - 1;
      const row: string[] = [];
      let next = 0;
      for (const [, cellTag, inner] of (body ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(cellTag!, "r");
        const col = ref ? columnIndex(ref) : next;
        next = col + 1;
        const type = attr(cellTag!, "t");
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner ?? "")?.[1];
        let value = "";
        if (type === "s") value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = texts(/<is>([\s\S]*?)<\/is>/.exec(inner ?? "")?.[1] ?? "");
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (v !== undefined) {
          value = unescapeXml(v);
          // 0.80000000000000004 → 0.8: numbers come back the way they were typed.
          if (type !== "str" && type !== "e" && value.trim() !== "" && Number.isFinite(Number(value))) value = String(Number(value));
        }
        while (row.length < col) row.push("");
        row[col] = value;
      }
      while (rows.length < r) rows.push([]);
      rows[r] = row;
    }
    book[name] = rows;
  }
  return book;
}

export interface SheetLayout {
  /** Column widths in characters. */
  widths?: number[];
  /** A drop-down list for a column: the values come from a range of another sheet, e.g. "Справочник!$A$2:$A$9". */
  lists?: { column: number; range: string }[];
}

/**
 * Writes a workbook: the first row of each sheet is a bold frozen header; cells are text and wrap.
 * Drop-down lists reference ranges, so Google Sheets and Excel both keep them on import.
 */
export function writeXlsx(book: Workbook, layout: Record<string, SheetLayout> = {}): Uint8Array {
  const names = Object.keys(book);
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, xml: string) => (files[path] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`));
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

  put(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join("")}</Types>`,
  );
  put(
    "_rels/.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  put(
    "xl/workbook.xml",
    `<workbook ${NS}><sheets>${names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
  );
  put(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join("")}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  // Style 1: header (bold, grey fill); style 2: body (wrapped, top-aligned).
  put(
    "xl/styles.xml",
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDEDED"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );
  names.forEach((name, i) => {
    const rows = book[name]!;
    const l = layout[name] ?? {};
    const cols = l.widths?.length ? `<cols>${l.widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
    const data = rows
      .map((row, r) => {
        const cells = row
          .map((v, c) => (v === "" ? "" : `<c r="${columnName(c)}${r + 1}" t="inlineStr" s="${r === 0 ? 1 : 2}"><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`))
          .join("");
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join("");
    const last = Math.max(rows.length, 200);
    const lists = l.lists?.length
      ? `<dataValidations count="${l.lists.length}">${l.lists
          .map((v) => `<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="${columnName(v.column)}2:${columnName(v.column)}${last}"><formula1>${escapeXml(v.range)}</formula1></dataValidation>`)
          .join("")}</dataValidations>`
      : "";
    put(
      `xl/worksheets/sheet${i + 1}.xml`,
      `<worksheet ${NS}><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${data}</sheetData>${lists}</worksheet>`,
    );
  });
  return zipSync(files, { level: 6 });
}
