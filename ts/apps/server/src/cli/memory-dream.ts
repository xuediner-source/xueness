/** Explicit terminal commands for proposing and reviewing project-memory curation. */
import type { Cli } from "./host.ts";
import type { Parser } from "./argparse.ts";

type Sub = ReturnType<Parser["subparsers"]>;

export function register(sub: Sub): void {
  const group = sub.add("memory-dream", "curate project KEY.md from selected sessions with explicit review").subparsers("action", true);
  group.add("propose").add("--session", { required: true }).add("--source", { action: "append", default: [], metavar: "SESSION_ID", help: "source session (repeatable; default selects recent project sessions)" }).add("--name");
  group.add("list").add("--session", { required: true });
  group.add("show").add("id").add("--session", { required: true });
  group.add("start").add("id").add("--session", { required: true }).add("--digest", { required: true }).add("--approve", { action: "store_true" }).add("--allow-real", { action: "store_true" });
  group.add("cancel").add("id").add("--session", { required: true });
  group.add("apply").add("id").add("--session", { required: true }).add("--digest", { required: true }).add("--approve", { action: "store_true" });
  group.add("diff").add("id").add("--session", { required: true });
  group.add("revert").add("id").add("--session", { required: true }).add("--digest", { required: true }).add("--approve", { action: "store_true" });
}

export async function execute(cli: Cli): Promise<number | null> {
  const args = cli.args;
  if (args.cmd !== "memory-dream") return null;
  const base = `/api/sessions/${encodeURIComponent(String(args.session))}/memory-dreams`;
  if (args.action === "list") return cli.report(await cli.api("GET", base));
  if (args.action === "propose") {
    const sources = Array.isArray(args.source) && args.source.length ? { sourceSessionIds: args.source as string[] } : {};
    return cli.report(await cli.api("POST", base, { ...sources, ...(args.name ? { name: String(args.name) } : {}) }));
  }
  const id = encodeURIComponent(String(args.id)), target = `${base}/${id}`;
  if (args.action === "show") return cli.report(await cli.api("GET", target));
  if (args.action === "diff") return cli.report(await cli.api("GET", `${target}/diff`));
  if (args.action === "cancel") return cli.report(await cli.api("POST", `${target}/cancel`));
  if (args.action === "revert") return cli.report(await cli.api("POST", `${target}/revert`, { digest: args.digest, confirmed: args.approve === true }));
  if (args.action === "apply") return cli.report(await cli.api("POST", `${target}/apply`, { digest: args.digest, confirmed: args.approve === true }));
  if (args.action === "start") {
    const started = await cli.api("POST", `${target}/start`, { digest: args.digest, confirmed: args.approve === true, allowReal: args.allow_real === true });
    if (started[0] >= 400) return cli.report(started);
    const app = await cli.host();
    await app.memoryDreams.wait(String(args.id));
    return cli.report(await cli.api("GET", target));
  }
  return cli.error("unsupported memory-dream action");
}
