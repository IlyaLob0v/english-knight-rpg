import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FileTooLargeError, type FileStore } from "./files.js";

export interface S3Config {
  /** https://storage.yandexcloud.net for Yandex Object Storage; any S3-compatible endpoint works. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
/** RFC 3986 encoding of one path segment, as Signature V4 wants it. */
const encodeSegment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  host: string;
  path: string;
  /** Lower-case names. host, x-amz-date and x-amz-content-sha256 are added. */
  headers: Record<string, string>;
  payloadHash: string;
  date: Date;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** AWS Signature Version 4: the headers to send, Authorization included. */
export function signV4(i: SignInput): Record<string, string> {
  const amzDate = i.date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...i.headers, host: i.host, "x-amz-content-sha256": i.payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonical = [
    i.method,
    i.path,
    "",
    ...names.map((n) => `${n}:${String(headers[n]).trim().replace(/\s+/g, " ")}`),
    "",
    names.join(";"),
    i.payloadHash,
  ].join("\n");
  const scope = `${day}/${i.region}/${i.service ?? "s3"}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, day), i.region), i.service ?? "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

/**
 * Homework files in an S3-compatible bucket in a Russian region (Yandex Object Storage). The
 * upload is spooled to a temporary file first: the size limit is checked before anything
 * reaches the bucket, and the bucket gets a signed payload of known length.
 */
export class S3FileStore implements FileStore {
  private readonly url: URL;

  constructor(
    private readonly c: S3Config,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.url = new URL(c.endpoint);
  }

  private send(method: string, key: string, extra: { headers?: Record<string, string>; payloadHash?: string; body?: Readable } = {}): Promise<IncomingMessage> {
    const path = `/${encodeSegment(this.c.bucket)}/${key.split("/").map(encodeSegment).join("/")}`;
    const headers = signV4({
      method,
      host: this.url.host,
      path,
      headers: extra.headers ?? {},
      payloadHash: extra.payloadHash ?? sha256(""),
      date: this.now(),
      region: this.c.region,
      accessKeyId: this.c.accessKeyId,
      secretAccessKey: this.c.secretAccessKey,
    });
    const request = this.url.protocol === "http:" ? httpRequest : httpsRequest;
    return new Promise((resolve, reject) => {
      const req = request(new URL(path, this.url), { method, headers }, resolve);
      req.on("error", reject);
      if (extra.body) extra.body.on("error", (e) => req.destroy(e)).pipe(req);
      else req.end();
    });
  }

  private async expect(res: IncomingMessage, ok: number[], what: string): Promise<void> {
    if (ok.includes(res.statusCode ?? 0)) return void res.resume();
    let text = "";
    for await (const chunk of res) text += chunk;
    throw new Error(`S3 ${what}: HTTP ${res.statusCode} ${text.slice(0, 300)}`);
  }

  async put(key: string, body: Readable, limit: number): Promise<number> {
    const dir = await mkdtemp(join(tmpdir(), "moonbridge-upload-"));
    const spool = join(dir, "file");
    try {
      let size = 0;
      const hash = createHash("sha256");
      const counter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          size += chunk.length;
          if (size > limit) return done(new FileTooLargeError(limit));
          hash.update(chunk);
          done(null, chunk);
        },
      });
      try {
        await pipeline(body, counter, createWriteStream(spool));
      } catch (e) {
        // Drain the rest of the request so the client gets the 413 instead of a reset connection.
        body.resume();
        throw e;
      }
      if (size > 0) {
        const res = await this.send("PUT", key, { headers: { "content-length": String(size) }, payloadHash: hash.digest("hex"), body: createReadStream(spool) });
        await this.expect(res, [200], `PUT ${key}`);
      }
      return size;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async open(key: string) {
    const res = await this.send("GET", key);
    if (res.statusCode === 404) {
      res.resume();
      return undefined;
    }
    if (res.statusCode !== 200) await this.expect(res, [200], `GET ${key}`);
    return { stream: res as Readable, size: Number(res.headers["content-length"] ?? 0) };
  }

  async delete(key: string): Promise<void> {
    await this.expect(await this.send("DELETE", key), [200, 204, 404], `DELETE ${key}`);
  }
}
