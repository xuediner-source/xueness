/**
 * ZIP archives the way Python's `zipfile` reads them (the Office plugin's only
 * container format): central directory with `concat` offset tolerance, the
 * local header name check, stored and deflated members, CRC verification and
 * an output cap on every inflate. Writing produces a plain deflated archive.
 * Nothing is extracted to disk.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

export class BadZipFile extends Error { override name = "BadZipFile"; }

export interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  headerOffset: number;
  isDir: boolean;
}

const CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";
function cp437(raw: Buffer): string {
  let text = "";
  for (const byte of raw) text += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
  return text;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  return table;
})();
export function crc32(data: Uint8Array): number {
  let crc = -1;
  for (let index = 0; index < data.length; index += 1) crc = CRC_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** `zipfile._EndRecData` without ZIP64: the end record, searched past an archive comment. */
function endRecord(data: Buffer): { entries: number; size: number; offset: number; location: number } {
  const read = (at: number) => ({ entries: data.readUInt16LE(at + 10), size: data.readUInt32LE(at + 12), offset: data.readUInt32LE(at + 16), location: at });
  if (data.length < 22) throw new BadZipFile("File is not a zip file");
  const last = data.length - 22;
  if (data.readUInt32LE(last) === 0x06054b50 && data.readUInt16LE(last + 20) === 0) return read(last);
  const start = Math.max(0, data.length - 65535 - 22);
  const at = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), last);
  if (at >= start && at + 22 <= data.length) return read(at);
  throw new BadZipFile("File is not a zip file");
}

export class ZipArchive {
  readonly entries: ZipEntry[] = [];
  private readonly byName = new Map<string, ZipEntry>();
  private readonly concat: number;

  private readonly data: Buffer;

  constructor(data: Buffer) {
    this.data = data;
    const end = endRecord(data);
    if (end.entries === 0xffff || end.size === 0xffffffff || end.offset === 0xffffffff) throw new BadZipFile("ZIP64 archives are not supported");
    this.concat = end.location - end.size - end.offset;
    if (this.concat < 0) throw new BadZipFile("Bad offset for central directory");
    let at = end.offset + this.concat;
    const stop = at + end.size;
    if (stop > data.length) throw new BadZipFile("Truncated central directory");
    while (at < stop) {
      if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) throw new BadZipFile("Bad magic number for central directory");
      const flags = data.readUInt16LE(at + 8), nameLength = data.readUInt16LE(at + 28);
      const extra = data.readUInt16LE(at + 30), comment = data.readUInt16LE(at + 32);
      const rawName = data.subarray(at + 46, at + 46 + nameLength);
      let name: string;
      try { name = flags & 0x800 ? new TextDecoder("utf-8", { fatal: true }).decode(rawName) : cp437(rawName); } catch { throw new BadZipFile("invalid member name"); }
      const nul = name.indexOf("\0"); if (nul >= 0) name = name.slice(0, nul);
      const entry: ZipEntry = { name, flags, method: data.readUInt16LE(at + 10), crc: data.readUInt32LE(at + 16), compressedSize: data.readUInt32LE(at + 20),
        size: data.readUInt32LE(at + 24), headerOffset: data.readUInt32LE(at + 42), isDir: name.endsWith("/") };
      if (entry.size === 0xffffffff || entry.compressedSize === 0xffffffff || entry.headerOffset === 0xffffffff) throw new BadZipFile("ZIP64 members are not supported");
      this.entries.push(entry); this.byName.set(name, entry);
      at += 46 + nameLength + extra + comment;
    }
  }

  names(): string[] { return this.entries.map((entry) => entry.name); }
  has(name: string): boolean { return this.byName.has(name); }
  get(name: string): ZipEntry {
    const entry = this.byName.get(name);
    if (!entry) {
      // str(KeyError(message)) is the repr of the message.
      const message = `There is no item named '${name}' in the archive`;
      throw Object.assign(new Error(message.includes('"') ? `'${message.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'` : `"${message.replace(/\\/g, "\\\\")}"`), { name: "KeyError" });
    }
    return entry;
  }

  /** `ZipFile.read`: the member's bytes; `limit` caps the inflated output. */
  read(entry: ZipEntry | string, limit = Number.MAX_SAFE_INTEGER): Buffer {
    const info = typeof entry === "string" ? this.get(entry) : entry;
    const at = info.headerOffset + this.concat;
    if (at + 30 > this.data.length || this.data.readUInt32LE(at) !== 0x04034b50) throw new BadZipFile("Bad magic number for file header");
    const nameLength = this.data.readUInt16LE(at + 26), extra = this.data.readUInt16LE(at + 28);
    const rawName = this.data.subarray(at + 30, at + 30 + nameLength);
    const localName = info.flags & 0x800 ? rawName.toString("utf8") : cp437(rawName);
    if (localName.replace(/\0[\s\S]*$/, "") !== info.name) throw new BadZipFile(`File name in directory '${info.name}' and header '${localName}' differ.`);
    if (info.flags & 1) throw new BadZipFile("encrypted member");
    const start = at + 30 + nameLength + extra, raw = this.data.subarray(start, start + info.compressedSize);
    if (raw.length !== info.compressedSize) throw new BadZipFile("Truncated file header");
    let output: Buffer;
    if (info.method === 0) output = Buffer.from(raw);
    else if (info.method === 8) {
      try { output = inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(limit + 1, 0x7fffffff)) }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new BadZipFile("member exceeds the size limit"); throw new BadZipFile("Error -3 while decompressing data"); }
    } else throw new BadZipFile("compression method not supported");
    if (output.length > limit) throw new BadZipFile("member exceeds the size limit");
    if (output.length !== info.size || crc32(output) !== info.crc) throw new BadZipFile(`Bad CRC-32 for file '${info.name}'`);
    return output;
  }
}

/** A deflated archive, members in the given order, fixed 1980-01-01 timestamps. */
export function writeZip(members: readonly { name: string; data: Uint8Array | string }[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const data = typeof member.data === "string" ? Buffer.from(member.data, "utf8") : Buffer.from(member.data);
    const compressed = deflateRawSync(data), name = Buffer.from(member.name, "utf8"), crc = crc32(data);
    const flags = /[^\x00-\x7f]/.test(member.name) ? 0x800 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(8, 10); header.writeUInt16LE(0, 12); header.writeUInt16LE(0x21, 14); header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); central.push(header, name);
    offset += 30 + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
