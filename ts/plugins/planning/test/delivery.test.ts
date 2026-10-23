import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pyJsonLoads } from "@xueness/contracts";
import { checkDelivery, explicitOutputPaths, normalizeDelivery, planDelivery, requestsFileOutput, seedDelivery, type Row } from "../src/delivery.ts";
import { DELIVERY_GUIDANCE } from "../src/delivery-extension.ts";
import { workPolicy } from "../src/work-policy.ts";
import { PROJECT_ROOT, pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
const oracle = (inputs: Row[]): unknown[] => JSON.parse(runPython(readFileSync(join(PROJECT_ROOT, "ts/test-support/python/delivery_oracle.py"), "utf8"), JSON.stringify(inputs)));
async function invoke(item: Row): Promise<unknown> {
  try {
    const session = structuredClone(item.session ?? {}) as Row;
    switch (item.op) {
      case "intent": return { paths: explicitOutputPaths(item.task as string), requested: requestsFileOutput(item.task) };
      case "normalize": return normalizeDelivery(item.items);
      case "seed": seedDelivery(session); return session;
      case "plan": return { items: planDelivery(session, item.items), session };
      case "policy": return workPolicy(session);
      case "guidance": return DELIVERY_GUIDANCE;
      case "check": return await checkDelivery(item.root as string, session, item.summary as string ?? "", { enabled: (id) => !(item.disabled as string[] ?? []).includes(id), canRead: (path) => !(item.denied as string[] ?? []).includes(path) });
    }
  } catch (e) { return { error: (e as Error).name, message: (e as Error).message }; }
}
const requirement = (extra: Row = {}): Row => ({ id: "report", label: "Report", path: "report.md", contains: ["Requested section"], min_links: 2, ...extra });
describe("planning delivery Python differential", { skip: pythonUnavailableReason() ?? false }, () => {
  it("matches output intent, input exclusions, negations, seeding, immutable plans and fixed work policy", async () => {
    const tasks = ["Read input.md and write output/report.md", "Create a report about source.md", "Read report.md and summarize", "Research this in chat", "Save the answer", "Don't save result.md", "Do not create a file", "No need to export report.pdf", "Analyze source.xlsx and export report.csv", "读取 输入.md，输出到 结果.md", "不要保存到 report.md", "无需导出文档", "Generate result.json from source.json", "create https://site.test/report.md", "inspect output/report.md and source.csv", "write 中文.md and 数据.txt", "report as final.pdf", "Write C:\\out\\report.md using C:\\input\\source.txt", "create a spreadsheet", "create abc.md再读", "do not write output.md but create final.txt", "Read only; don't export", "Generate 😀.md", "save report.md, report.md"];
    const valid = requirement(), checks: Row[] = tasks.map((task) => ({ op: "intent", task }));
    checks.push(...[[], [null], [{ id: "a", label: "x" }], [valid, valid], [{ ...valid, id: "a!" }], [{ ...valid, label: "  " }], [{ ...valid, contains: null }], [{ ...valid, min_links: true }], [{ ...valid, min_links: null }], [{ ...valid, min_links: 101 }], [{ id: "chat", label: " 字段 ", contains: [" 内容 "], min_links: 0 }], [{ ...valid, label: "😀".repeat(500) }]].map((items) => ({ op: "normalize", items })));
    checks.push(...[{}, { task: 3 }, { task: "write final.md" }, { task: "save final.md", delivery_requirements: null }, { task: "write a.md and b.md", delivery_requirements: [{ id: "output_1", path: "old.md" }] }, { task: "save same.md", delivery_requirements: [{ id: "old", path: "same.md" }] }, { task: "save a.md", delivery_seeded: true }].map((session) => ({ op: "seed", session })));
    checks.push({ op: "plan", session: { delivery_requirements: [valid] }, items: [{ ...valid, contains: [] }] }, { op: "plan", session: { delivery_requirements: [valid] }, items: [valid, { id: "chat", label: "Answer", contains: ["Conclusion"] }] }, { op: "policy", session: {} }, { op: "policy", session: { runtime_profile: "lightweight" } }, { op: "guidance" });
    const expected = oracle(checks);
    for (const [i, item] of checks.entries()) assert.deepEqual(await invoke(item), expected[i], `case ${i} ${JSON.stringify(item)}`);
    assert.throws(() => normalizeDelivery(pyJsonLoads('[{"id":"a","label":"A","path":"a.md","min_links":1.0}]', { lossless: true })), /invalid minimum/);
  });
  it("checks generated file bytes, content markers, distinct links and plugin/gate refusal", async () => {
    const base = mkdtempSync(join(tmpdir(), "xue-delivery-")), root = join(base, "workspace"); mkdirSync(root); mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "report.md"), "Requested section\nhttps://one.test/x\nhttps://two.test/y\nhttps://one.test/x");
    writeFileSync(join(root, "nested", "result.txt"), "\ufeff要求✓\nhttp://@host.test/ http://user:pass@host.test/ https://[::1]/ https://bad.test:wrong/ https://[not-ip]/");
    writeFileSync(join(root, "empty.md"), "\ufeff \n"); writeFileSync(join(root, "binary.txt"), Buffer.from([0xff, 0xfe, 0])); writeFileSync(join(root, "huge.txt"), "x".repeat(2_000_001));
    writeFileSync(join(base, "outside.md"), "Requested section");
    const check = (extra: Row, params: Row = {}): Row => ({ op: "check", root, session: { task: "Write report", delivery_requirements: [requirement(extra)] }, ...params });
    const inputs: Row[] = [check({}), check({ contains: ["Missing"] }), check({ min_links: 3 }), check({ path: "nested/result.txt", contains: ["要求✓"], min_links: 4 }), check({ path: "empty.md", contains: [], min_links: 0 }), check({ path: "binary.txt" }), check({ path: "huge.txt" }), check({ path: "missing.md" }), check({ path: "nested" }), check({ path: "../outside.md" }), check({ path: join(root, "report.md") }), check({}, { disabled: ["files"] }), check({}, { denied: ["report.md"] }), check({ path: "report.docx" }, { disabled: ["office"] }), check({ path: null, contains: ["Conclusion"], min_links: 1 }, { summary: "Conclusion https://source.test" }), { op: "check", root, session: {} }, { op: "check", root, session: { delivery_requirements: [null] } }];
    try { const expected = oracle(inputs); for (const [i, item] of inputs.entries()) assert.deepEqual(await invoke(item), expected[i], `file case ${i}`); }
    finally { rmSync(base, { recursive: true, force: true }); }
  });
});
