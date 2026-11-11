import { deflateRawSync, crc32 } from "node:zlib";

/**
 * Build a real .zip archive from a set of files, with no external dependency —
 * a minimal ZIP writer (DEFLATE, method 8) using Node's own zlib + crc32. Used
 * so a customer can download their whole multi-page site's code as one file.
 */
export function zipFiles(files: Map<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [rawPath, content] of files) {
    const name = Buffer.from(rawPath.replace(/^\/+/, ""), "utf8"); // no leading slash inside a zip
    const data = Buffer.from(content, "utf8");
    const comp = deflateRawSync(data);
    const crc = crc32(data) >>> 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(8, 8); // method: deflate
    lh.writeUInt16LE(0, 10); // mod time
    lh.writeUInt16LE(0x21, 12); // mod date (1980-01-01, arbitrary)
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); // compressed size
    lh.writeUInt32LE(data.length, 22); // uncompressed size
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28); // extra length
    locals.push(lh, name, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(8, 10); // method
    cd.writeUInt16LE(0, 12); // time
    cd.writeUInt16LE(0x21, 14); // date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, name);

    offset += lh.length + name.length + comp.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(files.size, 8); // entries on this disk
  eocd.writeUInt16LE(files.size, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // central dir size
  eocd.writeUInt32LE(localBuf.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([localBuf, centralBuf, eocd]);
}
