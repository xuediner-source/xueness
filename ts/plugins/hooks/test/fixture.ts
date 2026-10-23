/** A state directory and workspace with every hook-loading case the Python plugin distinguishes. */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function hookFixture(): { base: string; root: string; state: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "xueness-hooks-")));
  const root = join(base, "ws"); const state = join(base, "state");
  const put = (path: string, text: string | Buffer): void => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
  const json = (value: unknown): string => JSON.stringify(value);
  const hooks = join(state, "resources", "hooks");
  put(join(hooks, "a.json"), json({ id: "veto", event: "PreToolUse", command: "/bin/sh", args: ["-c", "cat; exit 2"], matcher: "^exec$" }));
  put(join(hooks, "b.json"), json({ id: "off", event: "Stop", command: "true", enabled: false }));
  put(join(hooks, "c.json"), json({ id: "badevent", event: "Nope", command: "true" }));
  put(join(hooks, "d.json"), "{ broken");
  put(join(hooks, "e.json"), json({ id: "  spaced  ", event: "SessionStart", command: "/bin/echo", args: ["hi"] }));
  put(join(hooks, "f.json"), json({ id: "piped", event: "PostToolUse", command: "/bin/cat", pipeline: true }));
  put(join(hooks, "g.json"), json({ id: "ci", event: "PostToolUse", command: "/bin/true", matcher: "(?i)READ" }));
  put(join(hooks, "h.json"), json({ id: "blank", event: "Stop", command: "  " }));
  put(join(hooks, "i.json"), json({ id: "badre", event: "PreToolUse", command: "/bin/true", matcher: "[" }));
  put(join(hooks, "j.json"), "[]");
  put(join(hooks, "k.json"), "\ufeff" + json({ id: "bom", event: "Stop", command: "true" }));
  put(join(hooks, "l.json"), json({ id: "alias", event: "PreToolUse", command: "/bin/true", matcher: "Bash|Read" }));
  put(join(hooks, "m.json"), json({ id: "star", event: "UserPromptSubmit", command: "/bin/true", matcher: "*" }));
  put(join(hooks, "notes.txt"), json({ id: "txt", event: "Stop", command: "true" }));
  if (process.platform !== "win32") { put(join(base, "outside.json"), json({ id: "linked", event: "Stop", command: "true" })); symlinkSync(join(base, "outside.json"), join(hooks, "n.json")); }
  put(join(root, ".xueness", "hooks.json"), json([
    { id: "ws-pre", event: "PreToolUse", command: "/bin/sh", args: ["-c", "exit 0"], matcher: "Bash", timeout: 2.5 },
    { event: "PostToolUse", command: "/bin/true" },
    { id: "ws-off", event: "Stop", command: "/bin/true", enabled: false },
    { id: "", event: "Stop", command: "x" },
    { id: "bad-args", event: "Stop", command: "x", args: [1] },
    { id: "bad-timeout", event: "Stop", command: "x", timeout: -1 },
    { id: "bad-pipe", event: "Stop", command: "x", pipeline: "yes" },
    { id: "ws-pre", event: "Stop", command: "/bin/true" },
    "not an object",
    { id: "ws-piped", event: "PostToolUseFailure", command: "/bin/true", pipeline: true, matcher: "" },
  ]));
  put(join(root, ".zcode", "config.json"), json({ other: 1, hooks: { timeoutMs: 1500, events: {
    PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "process", command: "/bin/true", args: ["z"] }, { type: "command", command: "echo shell" }, { type: "process", command: "/bin/true", timeoutMs: 333.5 }] }],
    Stop: [{ hooks: [{ type: "process", command: "/bin/true", enabled: false }] }, { matcher: 3, hooks: [{ type: "process", command: "x" }] }, { hooks: [] }],
    Bogus: [],
    SessionStart: "nope",
  } } }));
  put(join(state, "workspace-hooks.json"), json({ enabled: true }));
  return { base, root, state };
}
