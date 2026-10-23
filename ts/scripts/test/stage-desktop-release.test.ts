/** Round 11: the Node release staging that replaces the missing tools/stage_desktop_release.py. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { checkRun, stage, StageError, WORKFLOW } from "../stage-desktop-release.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const VERSION = JSON.parse(readFileSync(join(ROOT, "desktop", "package.json"), "utf8")).version as string;
const SHA = "a".repeat(40), TEMP = mkdtempSync(join(tmpdir(), "xueness-stage-test-"));
after(() => rmSync(TEMP, { recursive: true, force: true }));
const yaml = { load: (text: string) => JSON.parse(text), dump: (value: unknown) => JSON.stringify(value) };
const sum = (algorithm: string, text: string, encoding: "hex" | "base64" = "hex") => createHash(algorithm).update(text).digest(encoding);

function artifacts(dir: string, tamper?: "installer" | "feed"): void {
  const write = (artifact: string, files: Record<string, string>, feed: [string, string]) => {
    const base = join(dir, artifact); mkdirSync(base, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(base, name), text);
    const [feedName, url] = feed, body = files[url]!;
    writeFileSync(join(base, feedName), JSON.stringify({ version: VERSION, files: [{ url, sha512: tamper === "feed" ? "x" : sum("sha512", body, "base64"), size: Buffer.byteLength(body) }], path: url }));
    writeFileSync(join(base, "SHA256SUMS.txt"), Object.entries(files).filter(([name]) => /\.(exe|zip|dmg)$/.test(name)).map(([name, text]) => `${sum("sha256", text)}  ${name}\n`).join(""));
    if (tamper === "installer") writeFileSync(join(base, url), body + "!");
  };
  write("Xueness-windows-x64", { [`Xueness-${VERSION}-windows-x64-setup.exe`]: "win", [`Xueness-${VERSION}-windows-x64-setup.exe.blockmap`]: "map" }, ["latest.yml", `Xueness-${VERSION}-windows-x64-setup.exe`]);
  for (const arch of ["x64", "arm64"]) write(`Xueness-macos-${arch}`, { [`Xueness-${VERSION}-macos-${arch}.zip`]: `zip-${arch}`, [`Xueness-${VERSION}-macos-${arch}.dmg`]: `dmg-${arch}` }, ["latest-mac.yml", `Xueness-${VERSION}-macos-${arch}.zip`]);
  mkdirSync(join(dir, "Xueness-Windows-update-smoke-evidence"), { recursive: true });
}

function fakeGh(options: { run?: Record<string, unknown>; release?: { isDraft: boolean }; tamper?: "installer" | "feed" } = {}) {
  const calls: string[][] = [];
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "run" && args[1] === "view") return JSON.stringify({ status: "completed", conclusion: "success", headSha: SHA, workflowName: WORKFLOW, ...options.run });
    if (args[0] === "run" && args[1] === "download") { artifacts(args[args.indexOf("--dir") + 1]!, options.tamper); return ""; }
    if (args[0] === "release" && args[1] === "view") { if (!options.release) throw new Error("release not found"); return JSON.stringify(options.release); }
    return "";
  };
  return { gh, calls };
}
const env = { XUENESS_BUILD_RUN: "123", GITHUB_SHA: SHA };

describe("desktop release staging", () => {
  it("creates a draft from verified artifacts and merges the two macOS feeds", () => {
    const { gh, calls } = fakeGh(), result = stage({ env, root: ROOT, yaml, gh });
    assert.equal(result.tag, `v${VERSION}`); assert.equal(result.created, true);
    assert.deepEqual(result.files, ["SHA256SUMS.txt", `Xueness-${VERSION}-macos-arm64.dmg`, `Xueness-${VERSION}-macos-arm64.zip`, `Xueness-${VERSION}-macos-x64.dmg`, `Xueness-${VERSION}-macos-x64.zip`, `Xueness-${VERSION}-windows-x64-setup.exe`, `Xueness-${VERSION}-windows-x64-setup.exe.blockmap`, "latest-mac.yml", "latest.yml"].sort());
    const create = calls.find((args) => args[0] === "release" && args[1] === "create")!;
    assert.deepEqual(create.slice(0, 9), ["release", "create", `v${VERSION}`, "--draft", "--target", SHA, "--title", `Xueness ${VERSION}`, "--notes-file"]);
    const feed = create.find((path) => path.endsWith("latest-mac.yml"))!, sums = create.find((path) => path.endsWith("SHA256SUMS.txt"))!;
    assert.deepEqual(JSON.parse(readFileSync(feed, "utf8")).files.map((row: { url: string }) => row.url), [`Xueness-${VERSION}-macos-arm64.zip`, `Xueness-${VERSION}-macos-x64.zip`]);
    assert.equal(readFileSync(sums, "utf8").trim().split("\n").length, 5);
  });
  it("refuses runs that failed, built another commit or came from another workflow", () => {
    assert.throws(() => checkRun({ status: "completed", conclusion: "failure", headSha: SHA, workflowName: WORKFLOW }, SHA), StageError);
    assert.throws(() => stage({ env, root: ROOT, yaml, gh: fakeGh({ run: { headSha: "b".repeat(40) } }).gh }), /not a{40}/);
    assert.throws(() => stage({ env, root: ROOT, yaml, gh: fakeGh({ run: { workflowName: "Other" } }).gh }), /belongs to "Other"/);
    assert.throws(() => stage({ env: { ...env, XUENESS_BUILD_RUN: "x" }, root: ROOT, yaml, gh: fakeGh().gh }), /run id/);
  });
  it("refuses tampered installers and feeds", () => {
    assert.throws(() => stage({ env, root: ROOT, yaml, gh: fakeGh({ tamper: "installer" }).gh }), /does not match SHA256SUMS/);
    assert.throws(() => stage({ env, root: ROOT, yaml, gh: fakeGh({ tamper: "feed" }).gh }), /does not match its sha512/);
  });
  it("refreshes an existing draft and never touches a published release", () => {
    const { gh, calls } = fakeGh({ release: { isDraft: true } });
    assert.equal(stage({ env, root: ROOT, yaml, gh }).created, false);
    assert.ok(calls.some((args) => args.slice(0, 4).join(" ") === `release upload v${VERSION} --clobber`));
    assert.ok(calls.some((args) => args.slice(0, 3).join(" ") === `release edit v${VERSION}`));
    const published = fakeGh({ release: { isDraft: false } });
    assert.throws(() => stage({ env, root: ROOT, yaml, gh: published.gh }), /already published/);
    assert.ok(!published.calls.some((args) => ["create", "upload", "edit"].includes(args[1]!)));
  });
});
