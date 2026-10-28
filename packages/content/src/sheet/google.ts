// A Google Sheets link → the workbook as .xlsx. The sheet must be shared "anyone with the link can view".

const MAX_BYTES = 10 * 1024 * 1024;

export class SheetFetchError extends Error {}

/** The .xlsx export address for a Google Sheets link, or undefined when the link is not one. */
export function googleExportUrl(link: string): string | undefined {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com") return undefined;
  const id = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(url.pathname)?.[1];
  return id ? `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx` : undefined;
}

/** Downloads the sheet. Errors are worded for the teacher. */
export async function fetchGoogleSheet(link: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const url = googleExportUrl(link);
  if (!url) throw new SheetFetchError("Это не ссылка на Google Таблицу: она должна начинаться с https://docs.google.com/spreadsheets/d/");
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new SheetFetchError("Google Таблицы не ответили. Попробуйте ещё раз или загрузите файл .xlsx.");
  }
  const type = res.headers.get("content-type") ?? "";
  // A closed sheet answers with Google's sign-in page instead of the file.
  if (res.status === 401 || res.status === 403 || res.status === 404 || type.includes("text/html")) {
    throw new SheetFetchError("Таблица закрыта. Откройте доступ: «Настройки доступа → Все, у кого есть ссылка (читатель)».");
  }
  if (!res.ok) throw new SheetFetchError(`Google Таблицы ответили ошибкой ${res.status}. Попробуйте ещё раз или загрузите файл .xlsx.`);
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.length > MAX_BYTES) throw new SheetFetchError("Таблица больше 10 МБ: в ней что-то лишнее, например картинки.");
  return body;
}
