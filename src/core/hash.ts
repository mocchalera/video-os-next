import { createHash } from "node:crypto";
import * as fs from "node:fs";

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256File(file: string): string {
  const h = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/**
 * Content identity for media: size + first 4 MiB + last 4 MiB.
 * Stable across machines and paths, cheap for large files, and not fooled by renames.
 */
export function contentId(file: string): string {
  const size = fs.statSync(file).size;
  const chunk = 4 << 20;
  const h = createHash("sha256");
  h.update(`vos-content-v1:${size}:`);
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(Math.min(chunk, size));
    fs.readSync(fd, head, 0, head.length, 0);
    h.update(head);
    if (size > chunk) {
      const tailLen = Math.min(chunk, size - chunk);
      const tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, size - tailLen);
      h.update(tail);
    }
  } finally {
    fs.closeSync(fd);
  }
  return "a_" + h.digest("hex").slice(0, 16);
}
