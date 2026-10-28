import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export class FileTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`file is larger than ${limit} bytes`);
  }
}

/**
 * Where homework files live. On disk for now; an S3-compatible bucket in a Russian region
 * (Yandex Object Storage, Selectel) implements the same three calls when the stand moves there.
 */
export interface FileStore {
  /** Streams the body into `key`, stopping with FileTooLargeError past `limit` bytes. Returns the size. */
  put(key: string, body: Readable, limit: number): Promise<number>;
  open(key: string): Promise<{ stream: Readable; size: number } | undefined>;
  delete(key: string): Promise<void>;
}

export class DiskFileStore implements FileStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error(`bad file key ${key}`);
    return p;
  }

  async put(key: string, body: Readable, limit: number): Promise<number> {
    const target = this.path(key);
    const partial = `${target}.part`;
    await mkdir(dirname(target), { recursive: true });
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        done(size > limit ? new FileTooLargeError(limit) : null, chunk);
      },
    });
    try {
      await pipeline(body, counter, createWriteStream(partial));
    } catch (e) {
      await rm(partial, { force: true });
      // Drain the rest of the request so the client gets the 413 instead of a reset connection.
      body.resume();
      throw e;
    }
    await rename(partial, target);
    return size;
  }

  async open(key: string) {
    const p = this.path(key);
    try {
      const { size } = await stat(p);
      return { stream: createReadStream(p), size };
    } catch {
      return undefined;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
