/** OAuth PKCE encoding and the oauth/check HTTP shapes against Python. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isDict, pyDecodeUtf8, pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { createMcpOpsHttp } from "../src/mcp-ops-http.ts";
import { oauthBegin, oauthRevoke, oauthStatus } from "../src/oauth.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const skip = pythonUnavailableReason() ?? false;
const server = {
  id: "srv", url: "https://mcp.example/r",
  oauth: { clientId: "c id!", authorizationEndpoint: "https://auth.example/authorize", tokenEndpoint: "https://auth.example/token", redirectUri: "http://127.0.0.1/cb", scope: "a b!'()*" },
};

function stateDir(): string {
  const state = mkdtempSync(join(tmpdir(), "xueness-oauth-"));
  mkdirSync(join(state, "resources", "mcp"), { recursive: true });
  writeFileSync(join(state, "resources", "mcp", "srv.json"), JSON.stringify({ ...server, transport: "http" }));
  return state;
}

describe("MCP OAuth matches Python", { skip }, () => {
  it("encodes the authorization query the way urllib.parse.urlencode does", async () => {
    const state = stateDir();
    try {
      const begun = await oauthBegin(state, server);
      const parsed = pyJsonLoads(pyDecodeUtf8(readFileSync(join(state, "mcp-oauth", "srv.json"))));
      if (!isDict(parsed)) throw new Error("pending OAuth state");
      if (typeof parsed.verifier !== "string" || typeof parsed.state !== "string") throw new Error("pending OAuth state");
      const challenge = createHash("sha256").update(parsed.verifier).digest("base64url");
      const pairs = [
        ["response_type", "code"], ["client_id", "c id!"], ["redirect_uri", "http://127.0.0.1/cb"],
        ["code_challenge", challenge], ["code_challenge_method", "S256"], ["state", parsed.state],
        ["resource", server.url], ["scope", "a b!'()*"],
      ];
      const encoded = runPython("import json,sys\nfrom urllib.parse import urlencode\npairs=json.loads(sys.stdin.read())\nprint(urlencode([(k, v) for k, v in pairs]))", JSON.stringify(pairs)).trim();
      assert.equal(begun.authorizationUrl, `https://auth.example/authorize?${encoded}`);
      assert.equal(begun.expiresIn, 600);
      assert.equal(begun.state, parsed.state);
      const pyStatus = runPython("import json,sys\nfrom xueness.bundled_plugins.mcp import oauth\nspec=json.loads(sys.stdin.read())\nprint(json.dumps(oauth.status(spec['state'], spec['sid'])))", JSON.stringify({ state, sid: "srv" })).trim();
      assert.equal(pyJsonDumps(oauthStatus(state, "srv")), pyStatus);
      assert.equal(pyJsonDumps(await oauthRevoke(state, "srv")), runPython("import json,sys\nfrom xueness.bundled_plugins.mcp import oauth\nspec=json.loads(sys.stdin.read())\nprint(json.dumps(oauth.revoke(spec['state'], spec['sid'])))", JSON.stringify({ state, sid: "srv" })).trim());
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it("refuses the same redirect and endpoint shapes", async () => {
    const state = stateDir();
    const cases = [
      { ...server, oauth: { ...server.oauth, redirectUri: "http://evil.example/cb" } },
      { ...server, oauth: { ...server.oauth, authorizationEndpoint: "https://auth.example/a?x=1" } },
      { ...server, oauth: { ...server.oauth, clientId: "" } },
      { ...server, oauth: { ...server.oauth, redirectUri: "http://[::1]/cb" } },
    ];
    try {
      const python = JSON.parse(runPython("import json,sys\nfrom xueness.bundled_plugins.mcp import oauth\nout=[]\nfor server in json.loads(sys.stdin.read()):\n    try:\n        oauth.begin(server.pop('_state'), server)\n        out.append({'ok': True})\n    except Exception as exc:\n        out.append({'ok': False, 'error': str(exc)})\nprint(json.dumps(out))", JSON.stringify(cases.map((item) => ({ ...item, _state: state }))))) as { ok: boolean; error?: string }[];
      const ours: { ok: boolean; error?: string }[] = [];
      for (const item of cases) {
        try { await oauthBegin(state, item); ours.push({ ok: true }); }
        catch (error) { ours.push({ ok: false, error: error instanceof Error ? error.message : "" }); }
      }
      assert.deepEqual(ours, python);
    } finally { rmSync(state, { recursive: true, force: true }); }
  });
});

describe("MCP OAuth and check HTTP", () => {
  it("matches lifecycle status codes and leaves workflows unowned", async () => {
    const state = stateDir();
    const project = mkdtempSync(join(tmpdir(), "xueness-oauth-root-"));
    const runs = mkdtempSync(join(tmpdir(), "xueness-oauth-runs-"));
    const api = createMcpOpsHttp({ stateDir: state, enabled: () => true, projectDir: project, webRuns: runs, allowedRoots: () => [project] });
    const off = createMcpOpsHttp({ stateDir: state, enabled: () => false, projectDir: project, webRuns: runs, allowedRoots: () => [project] });
    try {
      assert.equal(api.owns("GET", ["api", "workflows"]), false);
      assert.equal(api.owns("POST", ["api", "mcp", "check"]), true);
      assert.equal(api.owns("GET", ["api", "mcp", "srv", "oauth"]), true);
      assert.equal(api.owns("POST", ["api", "mcp", "srv", "resources"]), true);
      assert.deepEqual(await off.dispatch("GET", ["api", "mcp", "check"], {}, null), [403, { error: "plugin disabled or dependency unavailable: mcp", plugin: "mcp" }]);
      assert.deepEqual(await api.dispatch("GET", ["api", "mcp", "check"], {}, null), [405, { error: "method not allowed" }]);
      assert.deepEqual(await api.dispatch("POST", ["api", "mcp", "check"], {}, { connect: false }), [400, { error: "explicit connect approval required" }]);
      await assert.rejects(() => api.dispatch("POST", ["api", "mcp", "check"], {}, null), /attribute/);
      assert.deepEqual(await api.dispatch("POST", ["api", "mcp", "missing", "oauth", "nope"], {}, null), [404, { error: "MCP server not found" }]);
      assert.deepEqual(await api.dispatch("POST", ["api", "mcp", "srv", "oauth", "nope"], {}, null), [405, { error: "method not allowed" }]);
      assert.deepEqual(await api.dispatch("POST", ["api", "mcp", "srv", "oauth", "finish"], {}, null), [400, { error: "MCP request failed (details suppressed)" }]);
      const started = await api.dispatch("POST", ["api", "mcp", "srv", "oauth", "start"], {}, null);
      assert.equal(started?.[0], 200);
      assert.equal(typeof (started?.[1] as { authorizationUrl?: string }).authorizationUrl, "string");
      assert.deepEqual(await api.dispatch("POST", ["api", "mcp", "check"], {}, { connect: true, id: "missing", root: project }), [400, { error: "invalid operation, plan, approval or workspace" }]);
      const outside = mkdtempSync(join(tmpdir(), "xueness-oauth-outside-"));
      assert.deepEqual(await api.dispatch("POST", ["api", "mcp", "check"], {}, { connect: true, id: "srv", root: outside }), [400, { error: "invalid operation, plan, approval or workspace" }]);
      rmSync(outside, { recursive: true, force: true });
    } finally {
      rmSync(state, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
      rmSync(runs, { recursive: true, force: true });
    }
  });
});
