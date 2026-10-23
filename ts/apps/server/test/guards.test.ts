/**
 * Guard differential: the TypeScript ports of `_parse_authority`,
 * `_origin_authority`, `_host_ok`, `_origin_ok` and `_fetch_site_ok` must give
 * the same answer as `xueness/web.py` for curated and generated values.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkRequest, fetchSiteOk, hostOk, originAuthority, originOk, parseAuthority, type HeaderValues } from "../src/guards.ts";
import { isLoopbackAddress, parseIPv6 } from "../src/py-url.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const skipPython = pythonUnavailableReason() ?? false;
const RANDOM_CASES = Number(process.env.XUENESS_GUARD_CASES ?? 4000);

const HOSTS = [
  "127.0.0.1", "127.0.0.1:8137", "localhost", "LOCALHOST:80", "LocalHost:65535", "[::1]", "[::1]:8137", "[::ffff:127.0.0.1]:1",
  "[::ffff:7f00:1]", "[::127.0.0.1]", "127.1", "0127.0.0.1", "127.0.0.01", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:", "127.0.0.1:080",
  "a[::1]", "[v1.x]:80", "[::1%eth0]", "::1", "evil.com", "127.0.0.1.nip.io", "127.0.0.1:80:80", "127.0.0.1 ", " 127.0.0.1", "\x85127.0.0.1",
  "127.0.0.1\xa0", "user@127.0.0.1", "[::1]x", "[[::1]]", "[::1]]", "[0:0:0:0:0:0:0:1]", "[::0:1]", "[0::1]", "[::1:0]", "localhost.",
  "127.255.255.254:1", "128.0.0.1", "[::1]:", "[::1]:+1", "127.0.0.1:1e3", "[1::]", "[::]", "[0:0:0:0:0:0:0:0:1]", "[::1::]", "[:::1]",
  "[0000:0000:0000:0000:0000:0000:0000:0001]", "[00000::1]", "127.0.0.1:８０", "ｌocalhost", "", " ", "[]", "[", "]", "localhost:80/",
];
const ORIGIN_PREFIXES = ["http://", "https://", "HTTP://", "HtTpS://", "ftp://", "http:", "//", "http:///", "", " http://", "\x85https://", "http://u:p@", "http://@", "http://u@"];
const ORIGIN_SUFFIXES = ["", "/", "/path?q=1", "#frag", "?q", "/a/b#c", " ", "\xa0", "/路径"];
const PIECES = ["127.0.0.1", "localhost", "::1", "[::1]", "[", "]", ":", "8137", "0", "65535", "65536", "@", "%", "v1.x", "::ffff:127.0.0.1", " ", "\x85", "\xa0", "a", "0", ".", "/", "?", "#", "\\", "1", "ffff", "::", "%25", "[v1.x]", "LOCALHOST"];

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function generated(count: number): { hosts: string[]; origins: string[] } {
  const random = rng(20261017);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const hosts: string[] = [];
  const origins: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const host = Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(PIECES)).join("");
    hosts.push(random() < 0.5 ? pick(HOSTS) + (random() < 0.3 ? pick(PIECES) : "") : host);
    origins.push(pick(ORIGIN_PREFIXES) + (random() < 0.5 ? pick(HOSTS) : host) + pick(ORIGIN_SUFFIXES));
  }
  return { hosts: [...HOSTS, ...hosts], origins: [...HOSTS.map((host) => `http://${host}`), ...origins] };
}

describe("guards", () => {
  it("parses IPv6 like Python's ipaddress", () => {
    assert.deepEqual(parseIPv6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(parseIPv6("1::"), [1, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(parseIPv6("1::2::3"), null);
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::127.0.0.1"), false);
  });

  it("decides the documented cases", () => {
    assert.deepEqual(parseAuthority("127.0.0.1:8137"), ["127.0.0.1", 8137]);
    assert.deepEqual(parseAuthority("LOCALHOST"), ["localhost", 80]);
    assert.equal(parseAuthority("evil.com:8137"), null);
    assert.equal(parseAuthority("127.0.0.1:0"), null);
    for (const malformed of ["[::1]x", "[::1]]", "[::1][", "prefix[::1]", "[::1]:80:90"]) {
      assert.equal(parseAuthority(malformed), null, malformed);
      assert.equal(originAuthority(`http://${malformed}/path`), null, malformed);
    }
    assert.deepEqual(parseAuthority("[::ffff:127.0.0.1]:8137"), ["::ffff:127.0.0.1", 8137]);
    assert.equal(parseAuthority("[::ffff:192.168.1.1]:8137"), null);
    assert.deepEqual(originAuthority("https://[::1]/x"), ["::1", 443]);
    assert.equal(originAuthority("http://user@127.0.0.1"), null);
    const ok: HeaderValues = { host: ["127.0.0.1:8137"], origin: ["http://127.0.0.1:8137"], "sec-fetch-site": ["same-origin"] };
    assert.equal(checkRequest(ok), null);
    assert.equal(checkRequest({ ...ok, host: ["127.0.0.1:8137", "127.0.0.1:8137"] })?.payload.code, "host_not_permitted");
    assert.equal(checkRequest({ ...ok, origin: ["http://127.0.0.1:9999"] })?.payload.code, "host_not_permitted");
    assert.equal(checkRequest({ ...ok, "sec-fetch-site": ["same-site"] })?.payload.code, "host_not_permitted");
    assert.equal(checkRequest(ok, { desktopToken: "a".repeat(64) })?.payload.code, "desktop_auth_required");
    assert.equal(checkRequest({ ...ok, "x-xueness-desktop-token": ["a".repeat(64)] }, { desktopToken: "a".repeat(64) }), null);
    assert.equal(checkRequest(ok, { csrfToken: "t" })?.payload.code, "csrf_required");
    assert.equal(checkRequest({ ...ok, "x-csrf-token": ["t"] }, { csrfToken: "t" }), null);
    assert.equal(checkRequest({ ...ok, "x-csrf-token": ["t", "t"] }, { csrfToken: "t" })?.payload.code, "csrf_required");
  });

  it(`matches web.py on ${RANDOM_CASES} generated Host and Origin values`, { skip: skipPython }, () => {
    const { hosts, origins } = generated(RANDOM_CASES);
    const python = JSON.parse(runPython(`
import json, sys
from xueness import web
data = json.load(sys.stdin)
def tup(v):
    return None if v is None else [v[0], v[1]]
print(json.dumps({
    "hosts": [tup(web._parse_authority(h)) for h in data["hosts"]],
    "origins": [tup(web._origin_authority(o)) for o in data["origins"]],
}))
`, JSON.stringify({ hosts, origins }))) as { hosts: (string | number)[][]; origins: (string | number)[][] };
    const mismatches: string[] = [];
    hosts.forEach((host, index) => {
      const actual = parseAuthority(host);
      const expected = python.hosts[index] ?? null;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push(`host ${JSON.stringify(host)}: ts ${JSON.stringify(actual)} py ${JSON.stringify(expected)}`);
    });
    origins.forEach((origin, index) => {
      const actual = originAuthority(origin);
      const expected = python.origins[index] ?? null;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push(`origin ${JSON.stringify(origin)}: ts ${JSON.stringify(actual)} py ${JSON.stringify(expected)}`);
    });
    assert.deepEqual(mismatches.slice(0, 20), []);
    const accepted = python.hosts.filter(Boolean).length;
    assert.ok(accepted > hosts.length * 0.1 && accepted < hosts.length * 0.9, `accepted ${accepted} of ${hosts.length}`);
  });

  it("matches web.py on generated header sets with repeated headers", { skip: skipPython }, () => {
    const random = rng(7);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const hostChoices = ["127.0.0.1:8137", "localhost:8137", "[::1]:8137", "127.0.0.1", "evil.com", "127.0.0.1:0"];
    const originChoices = ["http://127.0.0.1:8137", "http://localhost:8137", "http://[::1]:8137/x", "http://127.0.0.1", "", "null", "http://evil.com", "https://127.0.0.1:8137"];
    const siteChoices = ["same-origin", "none", "same-site", "cross-site", " Same-Origin ", ""];
    const sets = Array.from({ length: 1500 }, () => {
      const set: Record<string, string[]> = {};
      const many = (choices: readonly string[]): string[] => Array.from({ length: [0, 1, 1, 1, 2][Math.floor(random() * 5)] as number }, () => pick(choices));
      set.host = many(hostChoices);
      set.origin = many(originChoices);
      set.referer = many(originChoices.map((origin) => (origin ? `${origin}/page` : origin)));
      set["sec-fetch-site"] = many(siteChoices);
      return set;
    });
    const python = JSON.parse(runPython(`
import json, sys
from xueness import web
class H:
    def __init__(self, d): self.d = {k.lower(): v for k, v in d.items()}
    def get_all(self, name): return self.d.get(name.lower()) or None
    def get(self, name): v = self.d.get(name.lower()); return v[0] if v else None
out = []
for d in json.load(sys.stdin):
    h = H(d)
    out.append([web._host_ok(h), web._origin_ok(h), web._fetch_site_ok(h)])
print(json.dumps(out))
`, JSON.stringify(sets))) as boolean[][];
    const mismatches = sets
      .map((set, index) => ({ set, ts: [hostOk(set), originOk(set), fetchSiteOk(set)], py: python[index] }))
      .filter(({ ts, py }) => JSON.stringify(ts) !== JSON.stringify(py));
    assert.deepEqual(mismatches.slice(0, 5), []);
  });
});
