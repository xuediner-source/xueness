/**
 * Pure binary helpers for the V4 physical wire (F11.02).
 *
 * Mirrors upstream `zcode-protocol-v4/wire-binary.ts`: CRC-32 (IEEE, reflected)
 * rendered as 8 lowercase hex chars, plus a hand-rolled base64 codec so encode
 * and decode round-trip identically in every runtime without Buffer.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export function isWireBase64(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 4 && BASE64_PATTERN.test(value);
}

/** CRC-32/ISO-HDLC over the raw bytes, lowercase hex, zero-padded to 8 chars. */
export function crc32WireBytes(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

export function encodeWireBytesBase64(bytes: Uint8Array): string {
  let result = '';
  let block = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const a = bytes[offset]!;
    const hasB = offset + 1 < bytes.byteLength;
    const hasC = offset + 2 < bytes.byteLength;
    const b = hasB ? bytes[offset + 1]! : 0;
    const c = hasC ? bytes[offset + 2]! : 0;
    block +=
      BASE64_ALPHABET[a >>> 2]! +
      BASE64_ALPHABET[((a & 0x03) << 4) | (b >>> 4)]! +
      (hasB ? BASE64_ALPHABET[((b & 0x0f) << 2) | (c >>> 6)]! : '=') +
      (hasC ? BASE64_ALPHABET[c & 0x3f]! : '=');
    if (block.length >= 16_384) {
      result += block;
      block = '';
    }
  }
  return result + block;
}

