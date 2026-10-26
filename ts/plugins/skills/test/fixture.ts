import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
/** A workspace and state directory with every skill-discovery case the Python loader distinguishes. */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const md = (name: string, description: string, body = "Body text.", extra = ""): string => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`;

export function skillFixture(): { base: string; root: string; state: string } {
  const base = mkdtempSync(join(tmpdir(), "xueness-skills-"));
  const root = join(base, "ws"); const state = join(base, "state");
  const put = (path: string, text: string | Buffer): void => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
  const project = join(root, ".xueness", "skills"); const compat = join(root, ".zcode", "skills"); const user = join(state, "skills");
  put(join(project, "alpha", "SKILL.md"), md("alpha", "Project alpha", "Use ${ZCODE_SKILL_DIR}/x.sh.\nSecond line.", "tags: [one, 'two', one, \"three\"]\n"));
  put(join(project, "alpha", "helper.sh"), "echo hi\n");
  put(join(project, "alpha", ".hidden"), "x");
  put(join(project, "folded", "SKILL.md"), "\ufeff---\r\nname: folded\r\ndescription: >\r\n  first part\r\n  second part\r\n\r\nother: 'quoted'\r\n# comment\r\n---\r\nfolded body\r\n");
  put(join(project, "literal", "SKILL.md"), "---\nname: literal\ndescription: |\n  line one\n    indented\n\nTags: a,b\n---\nliteral body\n");
  put(join(project, "nofront", "SKILL.md"), "no frontmatter here\n");
  put(join(project, "unclosed", "SKILL.md"), "---\nname: unclosed\ndescription: d\n");
  put(join(project, "broken", "SKILL.md"), "---\nnot a key line\n!!: x\n---\nbody\n");
  put(join(project, "badname", "SKILL.md"), md("Bad_Name", "x"));
  put(join(project, "nodesc", "SKILL.md"), "---\nname: nodesc\n---\nbody\n");
  put(join(project, "longdesc", "SKILL.md"), md("longdesc", "d".repeat(1025)));
  put(join(project, "binary", "SKILL.md"), Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]));
  put(join(project, "big", "SKILL.md"), md("big", "big one", "x".repeat(300 * 1024)));
  put(join(project, ".dotdir", "SKILL.md"), md("dotdir", "hidden dir"));
  mkdirSync(join(project, "empty"), { recursive: true });
  put(join(project, "notadir.md"), "file at root level");
  put(join(compat, "alpha", "SKILL.md"), md("alpha", "Compat alpha shadowed by project"));
  put(join(compat, "beta", "SKILL.md"), md("beta", "Compat beta — ünïcode"));
  put(join(user, "beta", "SKILL.md"), md("beta", "User beta shadowed"));
  put(join(user, "gamma", "SKILL.md"), md("gamma", "User gamma", "  \n  gamma body  \n"));
  put(join(base, "outside", "SKILL.md"), md("outside", "outside"));
  if (process.platform !== "win32") {
    symlinkSync(join(base, "outside"), join(user, "linkdir"));
    mkdirSync(join(user, "linkfile"), { recursive: true });
    symlinkSync(join(base, "outside", "SKILL.md"), join(user, "linkfile", "SKILL.md"));
    symlinkSync(join(base, "outside", "SKILL.md"), join(project, "alpha", "linked-attachment.md"));
  }
  const resources = join(state, "resources", "skills");
  put(join(resources, "r1.json"), JSON.stringify({ id: "r1", name: "Stored One", description: " stored  ", body: "stored body" }));
  put(join(resources, "r2.json"), JSON.stringify({ id: "gamma", name: "Different", body: "id collides with user gamma name" }));
  put(join(resources, "r3.json"), JSON.stringify({ id: "r3", name: "alpha", description: "name collides with project alpha" }));
  put(join(resources, "off.json"), JSON.stringify({ id: "off", name: "Off", enabled: false }));
  put(join(resources, "noname.json"), JSON.stringify({ id: "nn" }));
  put(join(resources, "bad.json"), "{ nope");
  put(join(resources, "list.json"), "[]");
  put(join(resources, "bom.json"), "\ufeff" + JSON.stringify({ id: "bom", name: "Bom" }));
  put(join(resources, ".dot.json"), JSON.stringify({ id: "dot", name: "Dot skill", description: "pathlib globs dotfiles" }));
  put(join(resources, "notes.txt"), JSON.stringify({ id: "txt", name: "Txt" }));
  return { base, root, state };
}
