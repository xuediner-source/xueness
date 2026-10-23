import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeText, detectEncoding, encodeText, looksBinary, toLf, withLineEnding, LfOffsetMap, detectLineEnding } from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const skipPython = pythonUnavailableReason() ?? false;

describe("text codec", () => {
  it("detects encodings and binary content", () => {
    assert.equal(detectEncoding(Buffer.from("plain ascii\n")), "utf-8");
    assert.equal(detectEncoding(Buffer.from("中文 UTF-8\n")), "utf-8");
    assert.equal(detectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), "utf-8-bom");
    assert.equal(detectEncoding(Buffer.from([0xff, 0xfe, 0x61, 0x00])), "utf-16le");
    assert.equal(detectEncoding(Buffer.from([0xfe, 0xff, 0x00, 0x61])), "utf-16be");
    assert.equal(detectEncoding(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), "gbk");
    assert.equal(detectEncoding(Buffer.from([0x95, 0x32, 0x82, 0x36])), "gb18030");
    assert.equal(looksBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])), true);
    assert.throws(() => detectEncoding(Buffer.from([1, 2, 3, 0, 4])), { code: "binary_file" });
    assert.throws(() => detectEncoding(Buffer.from([0x80, 0xff, 0xfe, 0x41])), { code: "unsupported_encoding" });
  });

  it("round-trips every supported encoding", () => {
    const sample = "第一行 line\n第二行 — “quotes” ‘x’\n";
    for (const encoding of ["utf-8", "utf-8-bom", "utf-16le", "utf-16be", "gbk", "gb18030"] as const) {
      const bytes = encodeText(sample, encoding);
      assert.equal(detectEncoding(bytes), encoding === "gb18030" ? "gbk" : encoding, encoding);
      assert.equal(decodeText(bytes, encoding).text, sample, encoding);
    }
    const astral = "emoji 🎉 and 𠀀 need four bytes";
    assert.equal(decodeText(encodeText(astral, "gb18030"), "gb18030").text, astral);
    assert.throws(() => encodeText(astral, "gbk"), { code: "unsupported_encoding" });
  });

  it("encodes GBK and GB18030 byte-for-byte like Python", { skip: skipPython }, () => {
    const oracle = JSON.parse(runPython(`
import json
chars = []
for lead in range(0x81, 0xff):
    for trail in range(0x40, 0xff):
        if trail == 0x7f:
            continue
        try:
            chars.append(bytes([lead, trail]).decode("gbk"))
        except UnicodeDecodeError:
            pass
gbk = "".join(dict.fromkeys(chars))
extra = "".join(chr(c) for c in range(0x80, 0x3000, 7) if not (0xd800 <= c < 0xe000)) + "🎉𠀀𪚥\\U0010FFFF"
print(json.dumps({"gbk": gbk, "gbkHex": gbk.encode("gbk").hex(), "extra": extra, "extraHex": extra.encode("gb18030").hex()}))
`)) as { gbk: string; gbkHex: string; extra: string; extraHex: string };
    assert.ok(oracle.gbk.length > 21_000, `oracle produced ${oracle.gbk.length} GBK characters`);
    assert.equal(Buffer.from(encodeText(oracle.gbk, "gbk")).toString("hex"), oracle.gbkHex);
    assert.equal(decodeText(Buffer.from(oracle.gbkHex, "hex"), "gbk").text, oracle.gbk);
    assert.equal(Buffer.from(encodeText(oracle.extra, "gb18030")).toString("hex"), oracle.extraHex);
    assert.equal(decodeText(Buffer.from(oracle.extraHex, "hex"), "gb18030").text, oracle.extra);
  });
});

describe("line endings", () => {
  it("maps LF offsets back to raw CRLF offsets", () => {
    const raw = "ab\r\ncd\nef\r\n";
    assert.equal(detectLineEnding(raw), "\r\n");
    const lf = toLf(raw);
    assert.equal(lf, "ab\ncd\nef\n");
    const map = new LfOffsetMap(raw);
    for (let offset = 0; offset <= lf.length; offset += 1) {
      const rawOffset = map.toRaw(offset);
      assert.equal(toLf(raw.slice(0, rawOffset)), lf.slice(0, offset), `offset ${offset}`);
    }
    assert.equal(withLineEnding("x\ny\n", "\r\n"), "x\r\ny\r\n");
  });
});
