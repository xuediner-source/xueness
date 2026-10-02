import test from "node:test";
import assert from "node:assert/strict";
import { parseMcpCatalog, parseMcpServers, parseOAuthStart, parseOAuthStatus, parsePromptArguments } from "./index";

test("parsePromptArguments accepts a JSON object and reports malformed text readably", () => {
  assert.deepEqual(parsePromptArguments('{"key":"value"}'), { key: "value" });
  assert.deepEqual(parsePromptArguments("{}"), {});
  assert.throws(() => parsePromptArguments("{key: value}"), /JSON/);
  assert.throws(() => parsePromptArguments("[1,2]"), /JSON/);
  assert.throws(() => parsePromptArguments("null"), /JSON/);
});

test("MCP response guards accept documented records and reject wrong JSON shapes", () => {
  assert.deepEqual(parseMcpServers([{ id: "docs", enabled: true, extra: { oauth: { issuer: "https://example.test" } } }]), [
    { id: "docs", enabled: true, extra: { oauth: { issuer: "https://example.test" } } },
  ]);
  assert.throws(() => parseMcpServers({ items: [] }), /Invalid MCP server response/);
  assert.throws(() => parseMcpServers([{ id: 4 }]), /Invalid MCP server response/);

  assert.deepEqual(parseOAuthStatus({ authorized: true, pending: false, expiresAt: 123 }), {
    authorized: true, pending: false, expiresAt: 123,
  });
  // The real OAuth endpoint uses null when no token expiry was reported.
  assert.deepEqual(parseOAuthStatus({ authorized: false, pending: false, expiresAt: null }), {
    authorized: false, pending: false,
  });
  assert.deepEqual(parseOAuthStatus({ authorized: true, pending: false, expiresAt: null }), {
    authorized: true, pending: false,
  });
  assert.throws(() => parseOAuthStatus({ authorized: "yes", pending: false }), /Invalid MCP OAuth status response/);
  assert.throws(() => parseOAuthStatus({ authorized: true, pending: false, expiresAt: Infinity }), /Invalid MCP OAuth status response/);

  assert.deepEqual(parseOAuthStart({ authorizationUrl: "https://auth.example.test/start", state: "nonce" }), {
    authorizationUrl: "https://auth.example.test/start", state: "nonce",
  });
  assert.throws(() => parseOAuthStart({ authorizationUrl: "http://auth.example.test/start", state: "nonce" }), /HTTPS/);
  assert.throws(() => parseOAuthStart({ authorizationUrl: "https://auth.example.test/start" }), /Invalid MCP OAuth response/);

  assert.deepEqual(parseMcpCatalog({ prompts: [{ name: "lookup" }] }, "prompts", "docs"), [
    { id: "lookup", kind: "prompts", serverId: "docs", name: "lookup", uri: undefined },
  ]);
  assert.throws(() => parseMcpCatalog({ prompts: [{ name: "" }] }, "prompts", "docs"), /Invalid MCP catalog response/);
});
