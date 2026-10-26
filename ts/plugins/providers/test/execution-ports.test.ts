import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveExecutionFallbackCandidates } from "@xueness/agent";
import {
  bindRequestAuthPort, composeRequestAuth, executionRequestDependency, isAuthFailure, sameProviderFallback,
  savedProfileRequestAuth, withCredentialRefresh,
  type RequestAuthFailure, type RequestAuthInput, type RequestAuthPort,
} from "../src/execution-ports.ts";
import { ProfileStore } from "../src/profile-store.ts";

const input = (providerId: string | null): RequestAuthInput => ({ providerId, modelId: "GLM-5.3", purpose: "off_peak" });

function storeWithProfiles(): { store: ProfileStore; close: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "xueness-ports-"));
  const store = new ProfileStore(join(directory, "state"));
  store.save({ id: "local-openai", name: "Local", baseUrl: "http://127.0.0.1:9/v1", model: "GLM-5.3-Turbo", apiKey: "sk-local", allowLoopbackHttp: true });
  store.save({ id: "local-openai-air", name: "Air", baseUrl: "http://127.0.0.1:9/v1", model: "GLM-5.3-Air", apiKey: "sk-air", allowLoopbackHttp: true });
  store.save({ id: "local-anthropic", name: "Claude", baseUrl: "http://127.0.0.1:9/v1", model: "claude-x", apiKey: "sk-anthropic", protocol: "anthropic", allowLoopbackHttp: true });
  store.save({ id: "keyless", name: "Keyless", baseUrl: "http://127.0.0.1:9/v1", model: "GLM-5.3-Turbo", allowLoopbackHttp: true });
  return { store, close: () => rmSync(directory, { recursive: true, force: true }) };
}

/** Isolates the credential environment variables the default selection reads. */
function withEnvEnv(values: Record<string, string | undefined>, body: () => void): void {
  const names = ["XUENESS_API_KEY", "ANTHROPIC_API_KEY", "XUENESS_PROVIDER"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) {
      if (values[name] === undefined) delete process.env[name];
      else process.env[name] = values[name];
    }
    body();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("savedProfileRequestAuth (the production port)", () => {
  it("resolves per-protocol credential headers at request time", () => {
    const { store, close } = storeWithProfiles();
    try {
      const port = savedProfileRequestAuth(store);
      assert.deepEqual(port.resolve(input("local-openai")).headers, { Authorization: "Bearer sk-local" });
      assert.deepEqual(port.resolve(input("local-anthropic")).headers, { "x-api-key": "sk-anthropic" });
    } finally { close(); }
  });

  it("fails before any network I/O when credentials are absent — no official account to fall back to", () => {
    const { store, close } = storeWithProfiles();
    try {
      const port = savedProfileRequestAuth(store);
      assert.throws(() => port.resolve(input("keyless")), /no credentials/);
      assert.throws(() => port.resolve(input("no-such-provider")), /provider profile not found/);
      // An empty registry and an empty environment leave nothing to resolve:
      // the port never substitutes a built-in account.
      withEnvEnv({}, () => {
        assert.throws(() => port.resolve(input(null)), /no credentials configured for the default selection/);
      });
    } finally { close(); }
  });

  it("reads the environment for the default selection and refreshes by re-reading the registry", () => {
    const { store, close } = storeWithProfiles();
    try {
      const port = savedProfileRequestAuth(store);
      withEnvEnv({ XUENESS_API_KEY: "sk-env" }, () => {
        assert.deepEqual(port.resolve(input(null)).headers, { Authorization: "Bearer sk-env" });
      });
      withEnvEnv({ XUENESS_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-env" }, () => {
        assert.deepEqual(port.resolve(input(null)).headers, { "x-api-key": "sk-ant-env" });
      });
      // A rotated key is picked up by refresh without rebuilding anything.
      store.save({ id: "local-openai", name: "Local", baseUrl: "http://127.0.0.1:9/v1", model: "GLM-5.3-Turbo", apiKey: "sk-rotated", allowLoopbackHttp: true });
      assert.deepEqual(port.refresh!(input("local-openai"), { statusCode: 401 }).headers, { Authorization: "Bearer sk-rotated" });
    } finally { close(); }
  });
});

describe("withCredentialRefresh", () => {
  const base: RequestAuthPort = {
    id: "base",
    resolve: () => ({ headers: { Authorization: "Bearer old" } }),
    refresh: () => ({ headers: { Authorization: "Bearer new" } }),
  };
  it("classifies authentication failures a refresh could cure", () => {
    const yes: RequestAuthFailure[] = [{ statusCode: 401 }, { statusCode: 403 }, { providerErrorCode: "invalid_api_key" }, { providerErrorCode: "AuthenticationError" }, { providerErrorCode: "token_expired" }];
    const no: RequestAuthFailure[] = [{ statusCode: 429 }, { statusCode: 500 }, { providerErrorCode: "3402" }, {}];
    for (const failure of yes) assert.equal(isAuthFailure(failure), true, JSON.stringify(failure));
    for (const failure of no) assert.equal(isAuthFailure(failure), false, JSON.stringify(failure));
  });
  it("refreshes only on authentication failures; other routes keep their own paths", () => {
    const port = withCredentialRefresh(base);
    assert.deepEqual(port.refresh!(input("p"), { statusCode: 401 }).headers, { Authorization: "Bearer new" });
    assert.throws(() => port.refresh!(input("p"), { statusCode: 429 }), /authentication failures/);
  });
  it("a port without refresh stays without one", () => {
    const port = withCredentialRefresh({ id: "static", resolve: () => ({ headers: {} }) });
    assert.equal(port.refresh, undefined);
  });
});

describe("composeRequestAuth (the off-peak shape: credentials plus ticket)", () => {
  it("merges headers in order and fails as a whole before any network I/O", () => {
    const ticket: RequestAuthPort = { id: "ticket", resolve: () => ({ headers: { "X-Off-Peak-Ticket-ID": "t1" } }) };
    const creds: RequestAuthPort = { id: "creds", resolve: () => ({ headers: { Authorization: "Bearer k" } }) };
    const composed = composeRequestAuth([creds, ticket]);
    assert.deepEqual(composed.resolve(input("p")).headers, { Authorization: "Bearer k", "X-Off-Peak-Ticket-ID": "t1" });
    assert.equal(composed.id, "creds+ticket");
    const failing = composeRequestAuth([creds, { id: "absent", resolve: () => { throw new Error("credentials absent"); } }]);
    assert.throws(() => failing.resolve(input("p")), /credentials absent/);
  });
  it("refresh refreshes every refreshable port and re-resolves the rest", () => {
    const ticket: RequestAuthPort = { id: "ticket", resolve: () => ({ headers: { "X-Off-Peak-Ticket-ID": "t2" } }) };
    const creds: RequestAuthPort = {
      id: "creds",
      resolve: () => ({ headers: { Authorization: "Bearer old" } }),
      refresh: () => ({ headers: { Authorization: "Bearer fresh" } }),
    };
    const composed = composeRequestAuth([creds, ticket]);
    assert.deepEqual(composed.refresh!(input("p"), { statusCode: 401 }).headers, { Authorization: "Bearer fresh", "X-Off-Peak-Ticket-ID": "t2" });
    assert.equal(composeRequestAuth([ticket]).refresh, undefined);
  });
});

describe("sameProviderFallback (unified with the F01 route)", () => {
  it("declares the provider's other model as the fallback target", () => {
    const declaration = sameProviderFallback({ providerId: "local-openai", model: "GLM-5.3-Air", reason: "quota", providerErrorCode: "3402" });
    assert.equal(declaration.providerId, "local-openai");
    assert.equal(declaration.sameProvider, true);
    assert.deepEqual(declaration.target, { providerId: "local-openai", modelId: "GLM-5.3-Air" });
    assert.deepEqual(declaration.rules, [{ reason: "quota", providerErrorCode: "3402" }]);
    assert.throws(() => sameProviderFallback({ providerId: "p", model: " ", reason: "r" }), /needs a provider and a model/);
    assert.throws(() => sameProviderFallback({ providerId: "p", model: "m", reason: "" }), /needs a reason/);
  });
  it("feeds the runtime candidates: same provider, other model — never an identical selection", () => {
    const candidates = resolveExecutionFallbackCandidates({
      declaredTarget: { providerId: "local-openai", modelId: "GLM-5.3-Air" },
      executionProviderId: "local-openai",
      executionModelId: "GLM-5.3-Turbo",
      allowSameProvider: true,
      sessionSelection: { providerId: "user-provider", modelId: "user-model" },
    });
    assert.deepEqual(candidates.map((candidate) => candidate.selection.modelId), ["GLM-5.3-Air", "user-model"]);
  });
});

describe("executionRequestDependency (the selection/request dependency)", () => {
  it("binds the F01 scope and the saved-profile port by default; a host-bound mock port runs the same production path", () => {
    const { store, close } = storeWithProfiles();
    try {
      withEnvEnv({}, () => {
        const dependency = executionRequestDependency(store, {
          selection: { providerId: "local-openai", model: "GLM-5.3-Turbo" },
          fallback: sameProviderFallback({ providerId: "local-openai", model: "GLM-5.3-Air", reason: "quota" }),
        });
        assert.equal(dependency.scope.selection.providerId, "local-openai");
        assert.equal(dependency.scope.fallback?.sameProvider, true);
        assert.deepEqual(dependency.auth.resolve(input("local-openai")).headers, { Authorization: "Bearer sk-local" });

        const mock: RequestAuthPort = { id: "local-mock", resolve: () => ({ headers: { Authorization: "Bearer mock" } }) };
        bindRequestAuthPort(mock);
        try {
          const mocked = executionRequestDependency(store, { selection: { providerId: "local-openai", model: "GLM-5.3-Turbo" } });
          assert.equal(mocked.auth.id, "local-mock");
          assert.deepEqual(mocked.auth.resolve(input("local-openai")).headers, { Authorization: "Bearer mock" });
        } finally { bindRequestAuthPort(null); }
      });
    } finally { close(); }
  });

  it("composes extra header ports (an off-peak ticket) into every request", () => {
    const { store, close } = storeWithProfiles();
    try {
      const ticket: RequestAuthPort = { id: "ticket", resolve: () => ({ headers: { "X-Off-Peak-Ticket-ID": "t9" } }) };
      const dependency = executionRequestDependency(store, {
        selection: { providerId: "local-openai", model: "GLM-5.3-Turbo" },
        authExtras: [ticket],
      });
      assert.equal(dependency.auth.id, "saved-profile+ticket");
      assert.deepEqual(dependency.auth.resolve(input("local-openai")).headers, { Authorization: "Bearer sk-local", "X-Off-Peak-Ticket-ID": "t9" });
    } finally { close(); }
  });
});
