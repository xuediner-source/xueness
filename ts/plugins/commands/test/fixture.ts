/** A workspace and state directory with every command-discovery case the Python loader distinguishes. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function commandFixture(): { base: string; root: string; state: string } {
  const base = mkdtempSync(join(tmpdir(), "xueness-commands-"));
  const root = join(base, "ws"), state = join(base, "state");
  const put = (path: string, text: string | Buffer): void => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
  const project = join(root, ".xueness", "commands"), compat = join(root, ".zcode", "commands"), user = join(state, "commands");
  put(join(project, "review.md"), "---\ndescription: Review the change\nargument-hint: <file> [focus]\nmodel: gpt-x\ncolor: blue\ncolor: red\n---\nReview $1 with focus $2.\nAll: $ARGUMENTS $10 !`git diff`\n");
  put(join(project, "plain.md"), "\ufeff# Plain heading\n\nJust text, no placeholders.\n");
  put(join(project, "folded.md"), "---\r\ndescription: >\r\n  first part\r\n  second part\r\n\r\n# comment\r\nArgument-Hint: '[x]'\r\n---\r\nBody ```!\nls\n``` end\r\n");
  put(join(project, "literal.md"), "---\ndescription: |\n  line one\n    indented\n\nnot a key\n---\n> quoted first line\nmore\n");
  put(join(project, "ns", "deep.md"), "Deep $1 command\n");
  put(join(project, "ns", "sub", "x.md"), "too deep\n");
  put(join(project, "ns", ".hidden.md"), "hidden\n");
  put(join(project, "ns", "notes.txt"), "ignored\n");
  put(join(project, "bad ns", "x.md"), "bad namespace\n");
  put(join(project, "bad name.md"), "bad name\n");
  put(join(project, ".dot.md"), "dot\n");
  put(join(project, "empty.md"), "---\ndescription: nothing\n---\n   \n");
  put(join(project, "unclosed.md"), "---\ndescription: d\n");
  put(join(project, "broken.md"), "---\nnot a key line\n!!: x\n---\nbody\n");
  put(join(project, "big.md"), "x".repeat(64 * 1024 + 5));
  put(join(project, "binary.md"), Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a]));
  put(join(project, "help.md"), "Shadowed by the chat builtin\n");
  put(join(project, "init.md"), "Shadowed by the built-in prompt\n");
  put(join(project, "git.md"), "Shadowed by a plugin command\n");
  put(join(project, "Upper.MD"), "Upper-case extension\n");
  put(join(compat, "review.md"), "Compat review shadowed\n");
  put(join(compat, "compat-only.md"), "---\ndescription: \"Compat only\"\n---\nCompat $ARGUMENTS\n");
  put(join(user, "user-cmd.md"), "User command $1\n");
  put(join(user, "review.md"), "User review shadowed\n");
  put(join(base, "outside.md"), "outside\n");
  if (process.platform !== "win32") {
    symlinkSync(join(base, "outside.md"), join(project, "linked.md"));
    symlinkSync(join(base, "outside.md"), join(project, "ns", "linked.md"));
  }
  const resources = join(state, "resources", "commands");
  put(join(resources, "res1.json"), JSON.stringify({ id: "res1", name: "Res One", description: "  desc  ", prompt: "Do $1 and $ARGUMENTS", enabled: true, extra: { a: 1 } }));
  writeFileSync(join(resources, "float.json"), '{"id": "float", "prompt": "float body", "weight": 1.0, "big": 12345678901234567890}');
  put(join(resources, "disabled.json"), JSON.stringify({ id: "disabled", prompt: "x", enabled: false }));
  put(join(resources, "noid.json"), JSON.stringify({ prompt: "x" }));
  put(join(resources, "badjson.json"), "{not json");
  put(join(resources, "review.json"), JSON.stringify({ id: "review", prompt: "resource review" }));
  put(join(resources, "help.json"), JSON.stringify({ id: "help", prompt: "resource help wins" }));
  put(join(resources, "init.json"), JSON.stringify({ id: "init", prompt: "resource init" }));
  put(join(resources, "content.json"), JSON.stringify({ id: "content", content: "content body $ARGUMENTS", prompt: "   " }));
  put(join(resources, "blank.json"), JSON.stringify({ id: "blank", prompt: "  " }));
  put(join(resources, "num.json"), JSON.stringify({ id: "num", name: 5, description: ["x"], prompt: "p" }));
  put(join(resources, "mismatch.json"), JSON.stringify({ id: "other-id", prompt: "file name differs" }));
  put(join(resources, "bad id.json"), JSON.stringify({ id: "bad id", prompt: "x" }));
  put(join(resources, "notes.txt"), "ignored");
  return { base, root, state };
}

/** Every in-chat command a bundled Python manifest claims. */
export function manifestCommands(projectRoot: string): Set<string> {
  const names = new Set<string>();
  const directory = join(projectRoot, "xueness", "bundled_plugins");
  for (const id of readdirSync(directory)) {
    try { const manifest = JSON.parse(readFileSync(join(directory, id, "manifest.json"), "utf8")) as { commands?: unknown }; if (Array.isArray(manifest.commands)) for (const name of manifest.commands) if (typeof name === "string") names.add(name); } catch { /* not a plugin */ }
  }
  return names;
}
