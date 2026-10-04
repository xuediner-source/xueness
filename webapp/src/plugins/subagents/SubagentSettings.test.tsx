import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderSummary, ResourceList } from "../../xuenessApi";
import {
  createSubagentSettingsLoader,
  draftFromResource,
  makeSubagentPayload,
  slugifySubagentId,
} from "./SubagentSettings";

const EMPTY_RESOURCES: ResourceList = { items: [], capability: { userScopeAvailable: true } };

test("provider reads are skipped while subagent resource reads remain available", async () => {
  let resourceReads = 0;
  let providerReads = 0;
  const loader = createSubagentSettingsLoader(
    async () => { resourceReads += 1; return EMPTY_RESOURCES; },
    async () => { providerReads += 1; return { providers: [] }; },
  );

  const disabled = await loader.load(false);
  assert.equal(resourceReads, 1);
  assert.equal(providerReads, 0);
  assert.equal(disabled?.resourcesResult.status, "fulfilled");
  assert.deepEqual(disabled?.providersResult, { status: "fulfilled", value: null });

  await loader.load(true);
  assert.equal(resourceReads, 2);
  assert.equal(providerReads, 1);
});

test("late provider and resource responses are discarded after a newer disabled refresh", async () => {
  const resources: Array<(value: ResourceList) => void> = [];
  let resolveProviders!: (value: { providers: ProviderSummary[] }) => void;
  let providerReads = 0;
  const loader = createSubagentSettingsLoader(
    () => new Promise(resolve => resources.push(resolve)),
    () => { providerReads += 1; return new Promise(resolve => { resolveProviders = resolve; }); },
  );

  const staleEnabled = loader.load(true);
  const latestDisabled = loader.load(false);
  assert.equal(providerReads, 1);
  resources[1](EMPTY_RESOURCES);
  const latest = await latestDisabled;
  assert.equal(latest?.resourcesResult.status, "fulfilled");
  assert.deepEqual(latest?.providersResult, { status: "fulfilled", value: null });

  resolveProviders({ providers: [] });
  resources[0](EMPTY_RESOURCES);
  assert.equal(await staleEnabled, null);
});

test("subagent resource drafts distinguish inherited tools from an empty whitelist", () => {
  const inherited = draftFromResource({ id: "reader", name: "Reader", createdAt: "", updatedAt: "" });
  const empty = draftFromResource({ id: "silent", name: "Silent", tools: [], createdAt: "", updatedAt: "" });
  assert.equal(inherited.toolsMode, "all");
  assert.equal(empty.toolsMode, "custom");
  assert.deepEqual(empty.tools, []);
  assert.deepEqual(makeSubagentPayload(inherited).tools, ["*"]);
  assert.deepEqual(makeSubagentPayload(empty).tools, []);
});

test("subagent payload persists runtime model fields, prompt details, tools, and display color", () => {
  const draft = draftFromResource({
    id: "analyst",
    name: "Analyst",
    description: "Inspect code",
    systemPrompt: "Be concise",
    color: "cyan",
    providerId: "team-profile",
    model: "gpt-6-sol",
    reasoningEffort: "high",
    tools: ["read", "grep"],
    createdAt: "",
    updatedAt: "",
  });
  assert.deepEqual(makeSubagentPayload(draft), {
    name: "Analyst",
    description: "Inspect code",
    systemPrompt: "Be concise",
    color: "cyan",
    providerId: "team-profile",
    model: "gpt-6-sol",
    reasoningEffort: "high",
    tools: ["read", "grep"],
    enabled: true,
  });
});

test("subagent IDs generated from names stay inside the resource ID format", () => {
  assert.equal(slugifySubagentId("  Repo Analyst / One  "), "repo-analyst-one");
  assert.equal(slugifySubagentId("🔥"), "");
});
