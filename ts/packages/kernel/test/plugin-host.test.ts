import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Context, PluginConfigError, PluginHost, type BundledPlugin } from "@xueness/kernel";
import { bundle } from "./support/manifests.ts";

const READ_TOOL = { name: "peek", gate: "read", mutating: false, concurrencySafe: true };

function hostOf(plugins: BundledPlugin[], options: ConstructorParameters<typeof PluginHost>[2] = {}): { kernel: Context; host: PluginHost } {
  const kernel = Context.create();
  return { kernel, host: new PluginHost(kernel, plugins, options) };
}

async function close({ kernel, host }: { kernel: Context; host: PluginHost }): Promise<void> {
  await host.dispose();
  await kernel.dispose();
}

describe("plugin host", () => {
  it("loads valid plugins after their dependencies and refuses invalid ones", async () => {
    const setup = hostOf([
      bundle("app", { dependencies: ["base"], inject: ["base.api"] }),
      bundle("base", { provides: ["base.api"] }, (ctx) => void ctx.provide("base.api", { ok: true })),
      bundle("audited", { entrypoint: "plugin.js" }),
      bundle("drifted", { inject: ["base.api"] }, () => {}, { inject: [] }),
      bundle("renamed", {}, () => {}, { name: "other" }),
      bundle("rival", { provides: ["base.api"] }),
      bundle("orphan", { dependencies: ["missing"] }),
    ]);
    const statuses = await setup.host.start();
    const byId = Object.fromEntries(statuses.map((status) => [status.id, status]));
    const ids = statuses.map((status) => status.id);
    assert.ok(ids.indexOf("base") < ids.indexOf("app"), "dependencies first");
    assert.deepEqual([byId.base?.state, byId.app?.state], ["active", "active"]);
    assert.deepEqual(byId.audited?.issues, ["/entrypoint external plugin code requires a separate audit"]);
    assert.match(byId.drifted?.issues[0] ?? "", /^\/inject does not match the code/);
    assert.match(byId.renamed?.issues[0] ?? "", /^\/id does not match the code's name "other"/);
    assert.deepEqual(byId.rival?.issues, ["/provides/0 is also declared by base"]);
    assert.deepEqual(byId.orphan?.issues, ["/dependencies/0 names an unknown plugin"]);
    for (const id of ["audited", "drifted", "renamed", "rival", "orphan"]) assert.equal(byId[id]?.state, "invalid", id);
    assert.deepEqual(setup.kernel.serviceNames().sort(), ["base.api", "plugin.app", "plugin.base"]);
    await close(setup);
  });

  it("loads a plugin only when its grant covers what it declares", async () => {
    const declared = { exec: ["git"], fs: { read: ["workspace"] } };
    const setup = hostOf([bundle("git", { capabilities: declared, tools: [READ_TOOL] }, (ctx) => void ctx.tool({ ...READ_TOOL, requires: { fs: { read: ["workspace"] } } }))], {
      grant: () => ({ fs: { write: ["workspace"] } }),
    });
    const [blocked] = await setup.host.start();
    assert.deepEqual([blocked?.state, blocked?.missingGrants, blocked?.activations], ["blocked", ["exec:git"], 0]);
    const active = await setup.host.setGrant("git", { exec: ["*"], fs: { read: ["workspace"] } });
    assert.deepEqual([active.state, active.missingGrants, setup.kernel.tools.ownerOf("peek")], ["active", [], "git"]);
    const revoked = await setup.host.setGrant("git", {});
    assert.deepEqual([revoked.state, revoked.missingGrants, setup.kernel.tools.size], ["blocked", ["fs.read:workspace", "exec:git"], 0]);
    await close(setup);
  });

  it("checks config against the manifest schema and restarts with the new config", async () => {
    const seen: unknown[] = [];
    const config = { schema: { type: "object", properties: { limit: { type: "integer", minimum: 1 } }, additionalProperties: false }, default: { limit: 5 } };
    const setup = hostOf([
      bundle("tuned", { config }, (_ctx, value) => void seen.push(value)),
      bundle("plain", {}),
      bundle("misconfigured", { config }),
    ], { config: { misconfigured: { limit: "many" } } });
    await setup.host.start();
    assert.deepEqual(seen, [{ limit: 5 }]);
    await assert.rejects(setup.host.configure("tuned", { limit: 0 }), PluginConfigError);
    await assert.rejects(setup.host.configure("tuned", { extra: true }), /extra/);
    assert.deepEqual([setup.host.status("tuned").activations, seen.length], [1, 1]);
    const restarted = await setup.host.configure("tuned", { limit: 9 });
    assert.deepEqual([restarted.state, restarted.activations, seen.at(-1)], ["active", 2, { limit: 9 }]);
    await assert.rejects(setup.host.configure("plain", { anything: 1 }), /takes no configuration/);
    const failed = setup.host.status("misconfigured");
    assert.equal(failed.state, "failed");
    assert.match(failed.error ?? "", /invalid config for plugin misconfigured/);
    assert.equal((await setup.host.configure("misconfigured", {})).state, "active");
    await close(setup);
  });

  it("pauses dependants while a dependency is disabled and resumes them after", async () => {
    const order: string[] = [];
    const setup = hostOf([
      bundle("base", { provides: ["base.api"] }, (ctx) => {
        ctx.provide("base.api", {});
        ctx.effect(() => () => void order.push("base stopped"));
      }),
      bundle("app", { dependencies: ["base"], inject: ["base.api"] }, (ctx) => {
        ctx.effect(() => () => void order.push(`app stopped (base.api ${ctx.has("base.api") ? "up" : "down"})`));
      }),
    ]);
    await setup.host.start();
    await setup.host.disable("base");
    const paused = setup.host.status("app");
    assert.deepEqual([paused.state, paused.blockedBy, paused.waitingFor.sort()], ["blocked", ["base"], ["base.api", "plugin.base"]]);
    assert.deepEqual(order, ["app stopped (base.api up)", "base stopped"]);
    await setup.host.enable("base");
    assert.deepEqual([setup.host.status("app").state, setup.host.status("app").activations], ["active", 2]);
    await close(setup);
    assert.deepEqual(order.slice(2), ["app stopped (base.api up)", "base stopped"]);
  });

  it("fails a plugin that oversteps its manifest and keeps nothing it acquired", async () => {
    const setup = hostOf([
      bundle("sneaky", { provides: ["sneaky.api"] }, (ctx) => {
        ctx.provide("sneaky.api", {});
        ctx.provide("someone.else", {});
      }),
      bundle("toolish", { tools: [READ_TOOL] }, (ctx) => void ctx.tool({ ...READ_TOOL, name: "poke" })),
      bundle("greedy", { tools: [{ ...READ_TOOL, name: "grab" }] }, (ctx) => void ctx.tool({ ...READ_TOOL, name: "grab", requires: { exec: ["*"] } })),
    ]);
    const statuses = Object.fromEntries((await setup.host.start()).map((status) => [status.id, status]));
    assert.match(statuses.sneaky?.error ?? "", /sneaky does not declare that it may provide service someone.else/);
    assert.match(statuses.toolish?.error ?? "", /toolish does not declare tool poke/);
    assert.match(statuses.greedy?.error ?? "", /greedy is not granted exec:\* \(tool grab\)/);
    for (const status of Object.values(statuses)) assert.equal(status.state, "failed");
    assert.deepEqual([setup.kernel.serviceNames(), setup.kernel.tools.size], [[], 0]);
    const retried = await setup.host.enable("sneaky");
    assert.deepEqual([retried.state, retried.activations], ["failed", 2]);
    await close(setup);
  });

  it("respects defaultEnabled and explicit choices", async () => {
    const setup = hostOf([bundle("optin", { defaultEnabled: false }), bundle("optout", {})], { enabled: { optout: false } });
    const states = (await setup.host.start()).map((status) => [status.id, status.state]);
    assert.deepEqual(states, [["optin", "disabled"], ["optout", "disabled"]]);
    assert.equal((await setup.host.enable("optin")).state, "active");
    await assert.rejects(setup.host.enable("nope"), /unknown plugin nope/);
    await close(setup);
    await assert.rejects(setup.host.start(), /disposed/);
  });
});
