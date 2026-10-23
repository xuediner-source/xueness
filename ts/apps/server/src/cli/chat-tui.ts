/** Adapt existing feature APIs to the sessions-owned terminal. */
import { createTuiSessionPort, rememberProjectPermission, type TuiChoice } from "@xueness/plugin-sessions";
import { chat as dynamicRunsChat } from "@xueness/plugin-workflows";
import { WorkflowStore } from "@xueness/plugin-workflows";
import { declaredReasoningLevels, ProfileStore } from "@xueness/plugin-providers";
import type { ApplicationApi } from "../application-api.ts";
import type { Session } from "@xueness/sessions";
import type { Cli } from "./host.ts";
import type { CliTerminal } from "./render.ts";
import { CHAT_HELP, CHAT_HELP_EN, manifestCommands } from "./chat-commands.ts";

export function connectChatTui(cli: Cli, host: ApplicationApi, terminal: CliTerminal, scope: {
  root(): string; session(): Session | null; commands(): Record<string, any>[]; setMode(mode: string): Promise<string>;
}) {
  if (!terminal.connect) return null;
  const choices = (): TuiChoice[] => {
    const owners = manifestCommands(cli), help = cli.language === "en" ? CHAT_HELP_EN : CHAT_HELP;
    const rows = help.split("\n").filter((line) => line.startsWith("/")).map((line) => {
      const name = line.slice(1).split(/\s/)[0]!;
      return { id: name, label: "/" + name, description: line.slice(name.length + 1).trim(), value: "/" + name };
    });
    for (const name of ["new", "resume", "fork", "queue", "tasks", "sidebar", "theme", "variant", "developer"]) rows.push({ id: name, label: "/" + name, description: "", value: "/" + name });
    for (const item of scope.commands()) rows.push({ id: item.id, label: "/" + item.id, description: item.description ?? "", value: "/" + item.id });
    return rows.filter((row, index) => rows.findIndex((other) => other.id === row.id) === index && (!owners.has(row.id) || cli.enabled(owners.get(row.id)!)));
  };
  const adapter = createTuiSessionPort({ store: host.store, stateDir: cli.state, root: scope.root, sessionId: () => scope.session()?.id as string | null,
    enabled: (id) => cli.enabled(id), commands: choices,
    selection: () => ({ providerId: cli.args.provider_id, model: cli.args.model ?? (scope.session()?.model_selection as Record<string, any>)?.model, effort: cli.args.reasoning_effort }),
    reasoningLevels: () => declaredReasoningLevels(new ProfileStore(cli.state), cli.args.provider_id, cli.args.model),
    api: (method, path, data) => cli.api(method, path, data), setMode: scope.setMode,
    stop: () => { const sid = scope.session()?.id; if (sid) host.agent.cancel(String(sid)); },
    workflows: async () => {
      const session = scope.session(); if (!session || !cli.enabled("workflows")) return [];
      const result = dynamicRunsChat(cli.state, host.store, session, "list") as Record<string, any>, store = new WorkflowStore(cli.state);
      const legacy = (result.runs ?? []).map((run: Record<string, any>) => {
        const record = store.load(run.id), nodes = Object.entries(record.nodes ?? {}) as [string, Record<string, any>][];
        return { ...run, nodesTotal: nodes.length, nodesSettled: nodes.filter(([, node]) => ["completed", "failed", "cancelled", "skipped"].includes(node.status)).length,
          actors: nodes.map(([id, node]) => ({ ...node, id, name: id })), logTail: nodes.flatMap(([id]) => store.log(run.id, id).output.split("\n").filter(Boolean).slice(-4).map((line) => `${id}: ${line}`)).slice(-12) };
      });
      const scripts = await host.dynamicWorkflows.list(String(session.id));
      return [...legacy, ...scripts.map(run => {
        const nodes = Object.values(run.nodes);
        return { id: run.id, name: run.name, status: run.status, phase: run.phase, nodesTotal: nodes.length,
          nodesSettled: nodes.filter(node => ['completed', 'failed'].includes(node.status)).length,
          actors: Object.values(run.actors).map(actor => ({ id: actor.id, name: actor.name, sessionId: actor.sessionId,
            status: nodes.filter(node => node.actorId === actor.id).at(-1)?.status ?? 'pending' })),
          logTail: run.events.filter(event => event.message).slice(-12).map(event => event.message), reports: run.reports };
      })];
    },
  });
  adapter.port.rememberPermission = async (request, rules) => { rememberProjectPermission(cli.state, scope.root(), request, rules); };
  terminal.connect(adapter.port);
  return adapter;
}
