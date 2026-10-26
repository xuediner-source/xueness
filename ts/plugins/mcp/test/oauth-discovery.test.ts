/**
 * F06.04: OAuth discovery and token lifecycle against a real isolated
 * authorization server on loopback http (the compatibility port), plus
 * deterministic refusal cases via an injected fetch implementation.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pyJsonLoads } from "@xueness/contracts";
import { assertPrivateFile } from "../../../test-support/private-file.ts";
import { createMcpOpsHttp } from "../src/mcp-ops-http.ts";
import { discoverOauth, discoverOauthEndpoints, wellKnownUrl } from "../src/oauth-discovery.ts";
import { oauthAuthorization, oauthBearer, oauthStatus } from "../src/oauth.ts";

interface Hit { path: string; body: string }

const hits: { token: Hit[]; revoke: Hit[]; register: Hit[] } = { token: [], revoke: [], register: [] };
let base = "";
let server: Server;
let badMode = false;

before(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const json = (row: unknown, status = 200): void => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(row)); };
      if (badMode) return json({ error: "server is having a bad day" }, 500);
      switch (request.url) {
        case "/.well-known/oauth-protected-resource":
          return json({ resource: `${base}/mcp`, authorization_servers: [base] });
        case "/.well-known/oauth-authorization-server":
          return json({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            revocation_endpoint: `${base}/revoke`,
            registration_endpoint: `${base}/register`,
            grant_types_supported: ["authorization_code", "refresh_token"],
            scopes_supported: ["mcp:read", "mcp:write"],
          });
        case "/register":
          hits.register.push({ path: request.url!, body });
          return json({ client_id: "dynamic-client", client_id_issued_at: 1, redirect_uris: [`${base}/cb`] });
        case "/token": {
          hits.token.push({ path: request.url!, body });
          const params = new URLSearchParams(body);
          const grant = params.get("grant_type");
          if (grant === "authorization_code") {
            if (params.get("code") !== "authcode" || !params.get("code_verifier")) return json({ error: "invalid_grant" }, 400);
            return json({ access_token: "tok-1", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1", scope: "mcp:read" });
          }
          if (grant === "refresh_token") {
            if (params.get("refresh_token") !== "refresh-1") return json({ error: "invalid_grant" }, 400);
            return json({ access_token: "tok-2", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-2", scope: "mcp:read" });
          }
          return json({ error: "unsupported_grant_type" }, 400);
        }
        case "/revoke":
          hits.revoke.push({ path: request.url!, body });
          return json({});
        default:
          response.writeHead(404); response.end("not found");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function fresh(): { state: string; project: string; runs: string; api: ReturnType<typeof createMcpOpsHttp> } {
  const state = mkdtempSync(join(tmpdir(), "xueness-oauth-disc-"));
  const project = mkdtempSync(join(tmpdir(), "xueness-oauth-disc-project-"));
  const runs = mkdtempSync(join(tmpdir(), "xueness-oauth-disc-runs-"));
  mkdirSync(join(state, "resources", "mcp"), { recursive: true });
  return { state, project, runs, api: createMcpOpsHttp({ stateDir: state, enabled: () => true, projectDir: project, webRuns: runs, allowedRoots: () => [project] }) };
}

const cleanup = (...paths: string[]): void => paths.forEach((path) => rmSync(path, { recursive: true, force: true }));
const fileTree = (root: string): string[] => readdirSync(root, { recursive: true }).map(String).sort();

describe("OAuth well-known URL construction", () => {
  it("inserts the well-known path between host and path (RFC 9728/8414)", () => {
    assert.equal(wellKnownUrl("https://auth.example", "oauth-authorization-server"), "https://auth.example/.well-known/oauth-authorization-server");
    assert.equal(wellKnownUrl("https://auth.example/", "oauth-authorization-server"), "https://auth.example/.well-known/oauth-authorization-server");
    assert.equal(wellKnownUrl("https://host.example:8443/mcp", "oauth-protected-resource"), "https://host.example:8443/.well-known/oauth-protected-resource/mcp");
    assert.equal(wellKnownUrl("http://127.0.0.1:9/mcp/", "oauth-protected-resource"), "http://127.0.0.1:9/.well-known/oauth-protected-resource/mcp");
    assert.throws(() => wellKnownUrl("http://evil.example/mcp", "oauth-protected-resource"), /invalid OAuth endpoint/);
  });
});

describe("OAuth discovery against an isolated server", () => {
  it("resolves protected resource and AS metadata endpoints", async () => {
    const found = await discoverOauthEndpoints(`${base}/mcp`);
    assert.equal(found.issuer, base);
    assert.deepEqual(found.authorizationServers, [base]);
    assert.equal(found.authorizationEndpoint, `${base}/authorize`);
    assert.equal(found.tokenEndpoint, `${base}/token`);
    assert.equal(found.revocationEndpoint, `${base}/revoke`);
    assert.equal(found.registrationEndpoint, `${base}/register`);
    assert.deepEqual(found.scopesSupported, ["mcp:read", "mcp:write"]);
  });

  it("fails closed with suppressed details on a non-loopback http resource", async () => {
    await assert.rejects(() => discoverOauthEndpoints("http://10.0.0.1:1/mcp"), /invalid OAuth endpoint/);
  });

  it("surfaces one suppressed failure for unreachable or malformed metadata", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    await assert.rejects(() => discoverOauthEndpoints(`${base}/mcp`, { fetchImpl }), /OAuth discovery failed \(details suppressed\)/);
    const missingServers = (async () => new Response(JSON.stringify({ resource: "https://r" }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    await assert.rejects(() => discoverOauthEndpoints(`${base}/mcp`, { fetchImpl: missingServers }), /OAuth discovery failed \(details suppressed\)/);
    const noTokenEndpoint = (async (input: Parameters<typeof fetch>[0]) => new Response(
      String(input).includes("authorization-server") ? JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize` }) : JSON.stringify({ authorization_servers: [base] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;
    await assert.rejects(() => discoverOauthEndpoints(`${base}/mcp`, { fetchImpl: noTokenEndpoint }), /invalid OAuth endpoint/);
  });
});

describe("OAuth discovery and token lifecycle through the ops API", () => {
  it("discovers, dynamically registers, authorizes, refreshes and revokes", async () => {
    const { state, project, runs, api } = fresh();
    const url = `${base}/mcp`;
    writeFileSync(join(state, "resources", "mcp", "srv.json"), JSON.stringify({ id: "srv", transport: "http", url, oauth: { redirectUri: "http://127.0.0.1/cb" } }));
    const projectBefore = fileTree(project);
    try {
      // 1. Discovery + RFC 7591 dynamic registration (no static client id).
      const discovered = await api.dispatch("POST", ["api", "mcp", "srv", "oauth", "discover"], {}, null);
      assert.equal(discovered?.[0], 200);
      const payload = discovered?.[1] as Record<string, unknown>;
      assert.equal(payload.discovered, true);
      assert.equal(payload.registered, true);
      assert.deepEqual(payload.authorizationServers, [base]);
      assert.deepEqual(payload.endpoints, {
        authorizationEndpoint: `${base}/authorize`, tokenEndpoint: `${base}/token`,
        revocationEndpoint: `${base}/revoke`, registrationEndpoint: `${base}/register`,
      });
      assert.equal(JSON.stringify(payload).includes("refresh-1"), false);
      assert.equal(hits.register.length, 1);
      const registration = JSON.parse(hits.register[0]!.body) as Record<string, unknown>;
      assert.equal(registration.token_endpoint_auth_method, "none");
      assert.deepEqual(registration.redirect_uris, ["http://127.0.0.1/cb"]);
      // The cached client id is a secret-bearing state file outside the project.
      const cachePath = join(state, "mcp-oauth", "srv.discovery.json");
      const cache = pyJsonLoads(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
      assert.equal(cache.client_id, "dynamic-client");
      assertPrivateFile(cachePath);

      // 2. Authorization request: loopback http endpoints are the compatibility port.
      const started = await api.dispatch("POST", ["api", "mcp", "srv", "oauth", "start"], {}, null);
      assert.equal(started?.[0], 200);
      const begin = started?.[1] as { authorizationUrl: string; state: string };
      assert.ok(begin.authorizationUrl.startsWith(`${base}/authorize?`));
      const query = new URLSearchParams(begin.authorizationUrl.split("?")[1]!);
      assert.equal(query.get("client_id"), "dynamic-client");
      assert.equal(query.get("resource"), url);
      assert.equal(query.get("code_challenge_method"), "S256");
      assert.ok(query.get("code_challenge"));
      const status = await api.dispatch("GET", ["api", "mcp", "srv", "oauth"], {}, null);
      assert.deepEqual(status?.[1], { authorized: false, expiresAt: null, pending: true });

      // 3. Code exchange against the isolated token endpoint.
      const finished = await api.dispatch("POST", ["api", "mcp", "srv", "oauth", "finish"], {}, { code: "authcode", state: begin.state });
      assert.equal(finished?.[0], 200);
      assert.equal((finished?.[1] as { authorized: boolean }).authorized, true);
      assert.equal(hits.token.length, 1);
      const exchange = new URLSearchParams(hits.token[0]!.body);
      assert.equal(exchange.get("grant_type"), "authorization_code");
      assert.equal(exchange.get("code_verifier")!.length > 40, true);

      // 4. The bearer header flows and expiry triggers a refresh with rotation.
      const serverRow = { id: "srv", url, oauth: { redirectUri: "http://127.0.0.1/cb" }, _state_dir: state };
      assert.equal(await oauthAuthorization(serverRow), "Bearer tok-1");
      const tokenPath = join(state, "mcp-oauth", "srv.json");
      const stored = pyJsonLoads(readFileSync(tokenPath, "utf8")) as Record<string, unknown>;
      stored.expires_at = Date.now() / 1000 - 10;
      writeFileSync(tokenPath, JSON.stringify(stored));
      assert.equal(await oauthBearer(state, serverRow), "tok-2");
      assert.equal(hits.token.length, 2);
      const refreshed = new URLSearchParams(hits.token[1]!.body);
      assert.equal(refreshed.get("grant_type"), "refresh_token");
      assert.equal(refreshed.get("refresh_token"), "refresh-1");
      const rotated = pyJsonLoads(readFileSync(tokenPath, "utf8")) as Record<string, unknown>;
      assert.equal(rotated.refresh_token, "refresh-2");
      assert.equal(rotated.revocation_endpoint, `${base}/revoke`);

      // 5. Revocation reaches the server, clears every usable secret, leaks nothing.
      const revoked = await api.dispatch("POST", ["api", "mcp", "srv", "oauth", "revoke"], {}, null);
      assert.deepEqual(revoked?.[1], { authorized: false, expiresAt: null, pending: false });
      assert.equal(hits.revoke.length, 1);
      const revokedTokens = new URLSearchParams(hits.revoke[0]!.body);
      assert.equal(revokedTokens.get("token"), "refresh-2");
      assert.equal(revokedTokens.get("client_id"), "dynamic-client");
      await assert.rejects(() => oauthBearer(state, serverRow), /OAuth authorization required/);
      assert.deepEqual(oauthStatus(state, "srv"), { authorized: false, expiresAt: null, pending: false });
      const afterRevoke = pyJsonLoads(readFileSync(tokenPath, "utf8")) as Record<string, unknown>;
      assert.equal(afterRevoke.access_token, undefined);

      // 6. Secrets stayed out of the project package entirely.
      assert.deepEqual(fileTree(project), projectBefore);
      for (const name of readdirSync(join(state, "mcp-oauth"))) {
        const raw = readFileSync(join(state, "mcp-oauth", name), "utf8");
        if (name.endsWith(".json") && raw.includes("tok-")) throw new Error(`token leaked into ${name}`);
      }
    } finally {
      cleanup(state, project, runs);
    }
  });

  it("a complete static configuration skips the network entirely", async () => {
    const { state, project, runs, api } = fresh();
    writeFileSync(join(state, "resources", "mcp", "static.json"), JSON.stringify({
      id: "static", transport: "http", url: "https://mcp.example/r",
      oauth: { clientId: "c id!", authorizationEndpoint: "https://auth.example/authorize", tokenEndpoint: "https://auth.example/token", redirectUri: "http://127.0.0.1/cb" },
    }));
    try {
      badMode = true;
      const discovered = await api.dispatch("POST", ["api", "mcp", "static", "oauth", "discover"], {}, null);
      assert.equal(discovered?.[0], 200);
      assert.deepEqual(discovered?.[1], {
        discovered: true, authorizationServers: [], registered: false, alreadyConfigured: true,
        endpoints: { authorizationEndpoint: "https://auth.example/authorize", tokenEndpoint: "https://auth.example/token", revocationEndpoint: null, registrationEndpoint: null },
      });
      const started = await api.dispatch("POST", ["api", "mcp", "static", "oauth", "start"], {}, null);
      assert.equal((started?.[1] as { authorizationUrl: string }).authorizationUrl.startsWith("https://auth.example/authorize?"), true);
      // A complete static config leaves no discovery cache; the pending verifier
      // session in static.json is oauthBegin's own state, not discovery output.
      assert.equal(readdirSync(join(state, "mcp-oauth")).includes("static.discovery.json"), false);
    } finally {
      badMode = false;
      cleanup(state, project, runs);
    }
  });

  it("keeps begin refusals python-exact without discovery", async () => {
    const { state, project, runs, api } = fresh();
    try {
      const missing = await api.dispatch("POST", ["api", "mcp", "srv", "oauth", "start"], {}, null);
      assert.equal(missing?.[0], 404);
      writeFileSync(join(state, "resources", "mcp", "srv.json"), JSON.stringify({ id: "srv", transport: "http", url: `${base}/mcp`, oauth: { redirectUri: "http://127.0.0.1/cb" } }));
      badMode = true;
      // No cached client id and no reachable discovery: the refusal is Python's.
      assert.deepEqual(await api.dispatch("POST", ["api", "mcp", "srv", "oauth", "start"], {}, null), [400, { error: "MCP request failed (details suppressed)" }]);
      badMode = false;
      await discoverOauth(state, { id: "srv", url: `${base}/mcp`, oauth: { redirectUri: "http://127.0.0.1/cb" } });
      const started = await api.dispatch("POST", ["api", "mcp", "srv", "oauth", "start"], {}, null);
      assert.equal(started?.[0], 200);
    } finally {
      badMode = false;
      cleanup(state, project, runs);
    }
  });
});
