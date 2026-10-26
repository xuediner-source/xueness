import assert from "node:assert/strict";
import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, it } from "node:test";
import { crc32WireBytes, decodeWireBase64, encodeWireBytesBase64, isWireBase64 } from "../src/index.ts";

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("crc32WireBytes", () => {
  it("matches the CRC-32/ISO-HDLC check vectors", () => {
    assert.equal(crc32WireBytes(text("123456789")), "cbf43926");
    assert.equal(crc32WireBytes(text("a")), "e8b7be43");
    assert.equal(crc32WireBytes(text("abc")), "352441c2");
  });

  it("renders 8 lowercase zero-padded hex chars", () => {
    assert.equal(crc32WireBytes(new Uint8Array()), "00000000");
    assert.match(crc32WireBytes(text("x")), /^[0-9a-f]{8}$/u);
  });

  it("agrees with node:zlib crc32 across sample sizes", () => {
    for (const size of [1, 2, 3, 17, 255, 4096, 65537]) {
      const sample = new Uint8Array(size);
      for (let index = 0; index < size; index += 1) sample[index] = (index * 31 + 7) % 256;
      const expected = (zlibCrc32(sample) >>> 0).toString(16).padStart(8, "0");
      assert.equal(crc32WireBytes(sample), expected, `size ${size}`);
    }
  });
});

describe("wire base64 codec", () => {
  it("round-trips every length mod 3 and matches Buffer base64", () => {
    for (let size = 1; size <= 34; size += 1) {
      const sample = new Uint8Array(size);
      for (let index = 0; index < size; index += 1) sample[index] = (index * 7 + size) % 256;
      const encoded = encodeWireBytesBase64(sample);
      assert.equal(encoded, Buffer.from(sample).toString("base64"), `encode size ${size}`);
      const decoded = decodeWireBase64(encoded);
      assert.ok(decoded, `decode size ${size}`);
      assert.deepEqual([...decoded!], [...sample], `round-trip size ${size}`);
    }
  });

  it("round-trips a buffer crossing the 16384-char flush block", () => {
    const size = 100_003;
    const sample = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) sample[index] = (index * 2654435761) % 256;
    const encoded = encodeWireBytesBase64(sample);
    assert.equal(encoded, Buffer.from(sample).toString("base64"));
    assert.deepEqual([...decodeWireBase64(encoded)!], [...sample]);
  });

  it("encodes an empty buffer to the empty string", () => {
    assert.equal(encodeWireBytesBase64(new Uint8Array()), "");
  });

  it("decodes canonical padding forms", () => {
    assert.deepEqual([...decodeWireBase64("AB==")!], [0]);
    assert.deepEqual([...decodeWireBase64("AAA=")!], [0, 0]);
    assert.deepEqual([...decodeWireBase64("AAAA")!], [0, 0, 0]);
  });

  it("rejects malformed input with null instead of throwing", () => {
    for (const bad of ["", "a", "ab", "abc", "AB=C", "AB!C", "====", "A===", "AB=CDEF", "AAAA ", "AAAA\n", "ÄAAA"]) {
      assert.equal(isWireBase64(bad), false, `isWireBase64(${JSON.stringify(bad)})`);
      assert.equal(decodeWireBase64(bad), null, `decodeWireBase64(${JSON.stringify(bad)})`);
    }
  });

  it("accepts well-formed base64 in isWireBase64", () => {
    assert.equal(isWireBase64("AAAA"), true);
    assert.equal(isWireBase64("AB=="), true);
    assert.equal(isWireBase64(encodeWireBytesBase64(bytes(1, 2, 3, 4, 5))), true);
    assert.equal(isWireBase64(42), false);
    assert.equal(isWireBase64(null), false);
  });
});
