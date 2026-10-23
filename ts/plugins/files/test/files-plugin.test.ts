import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createToolEnv, runTool, type ToolDefinition } from "@xueness/engine-tools";
import { Context, PluginHost } from "@xueness/kernel";
import { FILE_TOOLS, files } from "@xueness/plugin-files";

const base = realpathSync(mkdtempSync(join(tmpdir(), "xueness-files-plugin-")));
after(() => rmSync(base, { recursive: true, force: true }));

describe("files plugin", () => {
  it("registers exactly the tools its manifest declares, and only with a write grant", async () => {
    const kernel = Context.create();
    const host = new PluginHost(kernel, [files], { grant: () => ({ fs: { read: ["workspace"] } }) });
    const [blocked] = await host.start();
    assert.deepEqual([blocked?.state, blocked?.missingGrants], ["blocked", ["fs.write:workspace"]]);
    const active = await host.setGrant("files", { fs: { write: ["workspace"] } });
    assert.equal(active.state, "active", active.error ?? "");
    const declared = host.manifest("files")?.tools ?? [];
    assert.deepEqual(kernel.tools.list().map((tool) => tool.name), declared.map((tool) => tool.name));
    for (const tool of declared) {
      const registered = kernel.tools.get(tool.name);
      assert.deepEqual([registered?.gate, registered?.mutating, registered?.concurrencySafe, kernel.tools.ownerOf(tool.name)], [tool.gate, tool.mutating, tool.concurrencySafe, "files"]);
    }
    assert.deepEqual(kernel.tools.list(), [...FILE_TOOLS]);

    const env = createToolEnv({ cwd: base, roots: [base], artifactsDir: join(tmpdir(), "xueness-files-artifacts") });
    writeFileSync(join(base, "hello.txt"), "hello\n");
    const read = kernel.tools.get<ToolDefinition>("read") as ToolDefinition;
    const result = await runTool(read, { path: "hello.txt" }, env);
    assert.equal(result.ok, true, result.output);
    assert.match(result.output, /hello/);

    await host.disable("files");
    assert.equal(kernel.tools.size, 0);
    await host.dispose();
    await kernel.dispose();
  });
});
