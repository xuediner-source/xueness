import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allCapabilities, capabilityIssues, capabilityTokens, hostAllowed, listenAllowed, missingGrants, normalizeCapabilities,
  programAllowed, programName, secretAllowed,
} from "../src/index.ts";

describe("plugin capabilities", () => {
  it("accepts the documented vocabulary and refuses everything else with a path", () => {
    assert.deepEqual(capabilityIssues({
      fs: { read: ["workspace", "home"], write: ["state"] },
      net: { connect: ["*", "loopback:8137", "api.openai.com", "*.example.com:443", "127.0.0.1"], listen: ["loopback"] },
      exec: ["git", "node", "python3", "*"],
      secrets: ["providers.*", "bots.telegram_token", "*"],
    }), []);
    assert.deepEqual(capabilityIssues({}), []);
    assert.deepEqual(capabilityIssues([]), [{ path: "/capabilities", message: "must be an object" }]);
    assert.deepEqual(capabilityIssues({
      fs: { read: ["root"], delete: [] },
      net: { connect: ["Example.com", "a..b", "host:0", "host:65536", "host:080", "http://x"], listen: ["public"] },
      exec: ["rm -rf", "git", "git"],
      secrets: ["Providers", "a.*.b"],
      gpu: true,
    }).map((issue) => `${issue.path} ${issue.message}`), [
      "/capabilities/fs/read/0 is not a valid file root",
      "/capabilities/fs/delete is not a known capability",
      "/capabilities/net/connect/0 is not a valid host pattern",
      "/capabilities/net/connect/1 is not a valid host pattern",
      "/capabilities/net/connect/2 is not a valid host pattern",
      "/capabilities/net/connect/3 is not a valid host pattern",
      "/capabilities/net/connect/4 is not a valid host pattern",
      "/capabilities/net/connect/5 is not a valid host pattern",
      "/capabilities/net/listen/0 is not a valid listen scope",
      "/capabilities/exec/0 is not a valid program name",
      "/capabilities/exec/2 duplicates \"git\"",
      "/capabilities/secrets/0 is not a valid secret pattern",
      "/capabilities/secrets/1 is not a valid secret pattern",
      "/capabilities/gpu is not a known capability",
    ]);
  });

  it("normalises: sorted, unique, wildcards absorb the rest, writing implies reading", () => {
    assert.deepEqual(normalizeCapabilities({ fs: { read: ["home", "workspace"], write: ["workspace", "temp"] }, exec: ["node", "git", "node"] }), {
      fs: { read: ["home", "temp", "workspace"], write: ["temp", "workspace"] },
      net: { connect: [], listen: [] },
      exec: ["git", "node"],
      secrets: [],
    });
    assert.deepEqual(normalizeCapabilities({ net: { connect: ["a.com", "*"], listen: ["loopback", "any"] }, exec: ["git", "*"] }).net, { connect: ["*"], listen: ["any"] });
    assert.deepEqual(capabilityTokens(normalizeCapabilities({ fs: { read: ["home"], write: ["workspace"] }, exec: ["git"], secrets: ["providers.*"] })),
      ["fs.read:home", "fs.write:workspace", "exec:git", "secrets:providers.*"]);
  });

  it("reports exactly the declared powers a grant does not cover", () => {
    const declared = normalizeCapabilities({
      fs: { read: ["home"], write: ["workspace"] },
      net: { connect: ["api.openai.com", "*.example.com", "localhost:3000"], listen: ["loopback"] },
      exec: ["git"],
      secrets: ["providers.openai"],
    });
    assert.deepEqual(missingGrants(declared, normalizeCapabilities()), capabilityTokens(declared));
    assert.deepEqual(missingGrants(declared, allCapabilities()), []);
    assert.deepEqual(missingGrants(declared, normalizeCapabilities({
      fs: { read: ["any"], write: ["state"] },
      net: { connect: ["*.openai.com", "*.example.com", "loopback"], listen: ["any"] },
      exec: ["git"],
      secrets: ["providers.*"],
    })), ["fs.write:workspace"]);
    // A port-limited grant covers only that port; "*" is not covered by a narrower grant.
    assert.deepEqual(missingGrants(normalizeCapabilities({ net: { connect: ["a.com"] } }), normalizeCapabilities({ net: { connect: ["a.com:443"] } })), ["net.connect:a.com"]);
    assert.deepEqual(missingGrants(normalizeCapabilities({ net: { connect: ["*"] } }), normalizeCapabilities({ net: { connect: ["*.com"] } })), ["net.connect:*"]);
    assert.deepEqual(missingGrants(normalizeCapabilities({ exec: ["*"] }), normalizeCapabilities({ exec: ["git", "node"] })), ["exec:*"]);
  });

  it("checks real hosts, listeners, programs and secrets at run time", () => {
    const caps = normalizeCapabilities({
      net: { connect: ["loopback", "api.openai.com:443", "*.example.com"], listen: ["loopback"] },
      exec: ["git", "node"],
      secrets: ["providers.*", "bots.token"],
    });
    assert.equal(hostAllowed(caps, "127.0.0.1", 8137), true);
    assert.equal(hostAllowed(caps, "[::1]", 1), true);
    assert.equal(hostAllowed(caps, "LOCALHOST", 80), true);
    assert.equal(hostAllowed(caps, "api.openai.com", 443), true);
    assert.equal(hostAllowed(caps, "api.openai.com", 80), false);
    assert.equal(hostAllowed(caps, "cdn.example.com", 80), true);
    assert.equal(hostAllowed(caps, "example.com", 80), false);
    assert.equal(hostAllowed(caps, "evil-example.com", 80), false);
    assert.equal(listenAllowed(caps, "127.0.0.1"), true);
    assert.equal(listenAllowed(caps, "0.0.0.0"), false);
    assert.equal(programName("C:\\Program Files\\Git\\cmd\\GIT.EXE"), "git");
    assert.equal(programAllowed(caps, "/usr/bin/git"), true);
    assert.equal(programAllowed(caps, process.execPath), true);
    assert.equal(programAllowed(caps, "/bin/sh"), false);
    assert.equal(secretAllowed(caps, "providers.openai"), true);
    assert.equal(secretAllowed(caps, "providers"), false);
    assert.equal(secretAllowed(caps, "bots.token"), true);
    assert.equal(secretAllowed(caps, "bots.token2"), false);
  });
});
