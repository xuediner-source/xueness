/**
 * `GET /api/visualizations`: a fragment in `<state>/visualizations/<session id>/`
 * comes back as the visualize skill's standalone page with sandboxing security
 * headers; anything else is refused before it is read.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PROJECT_ROOT } from "../../../test-support/python-oracle.ts";
import { sendBody } from "../src/respond.ts";
import { createRound8, VISUALIZATION_HEADERS, visualizationReply } from "../src/round8-http.ts";
import { BUNDLED_SKILLS_DIR } from "@xueness/plugin-skills";

const SKILL = join(BUNDLED_SKILLS_DIR, "visualize");
const state = realpathSync(mkdtempSync(join(tmpdir(), "xue-viz-route-")));
after(() => rmSync(state, { recursive: true, force: true }));
const sid = "0123456789abcdef0123456789abcdef";
const dir = join(state, "visualizations", sid);
mkdirSync(dir, { recursive: true });
const put = (path: string, content: string): string => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); return path; };

describe("visualizations route", () => {
  it("renders a session fragment with its title and security headers", () => {
    const file = put(join(dir, "sales-chart.html"), "<p>hi</p>");
    const reply = visualizationReply(state, SKILL, { path: [file] })!;
    assert.deepEqual([reply[0], reply[2], reply[3]], [200, "text/html; charset=utf-8", { ...VISUALIZATION_HEADERS }]);
    assert.ok(Buffer.isBuffer(reply[1]) && reply[1].toString("utf8").includes("<title>Sales Chart</title>"));
    assert.ok(String(visualizationReply(state, SKILL, { path: [file], title: ["A <b>"] })![1]).includes("<title>A &lt;b&gt;</title>"));
    assert.equal(VISUALIZATION_HEADERS["Content-Security-Policy"], "sandbox allow-scripts; frame-ancestors 'self'");
  });

  it("refuses paths outside a session directory and fragments the renderer refuses", (context) => {
    const outside = put(join(state, "other.html"), "<p>x</p>");
    const real = put(join(dir, "real.html"), "<p>x</p>");
    let linked = true;
    try { symlinkSync(outside, join(dir, "link-out.html")); symlinkSync(real, join(dir, "link-in.html")); }
    catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) linked = false; else throw error; }
    const cases: Array<[Record<string, string[]>, number]> = [
      [{}, 400], [{ path: ["relative.html"] }, 400], [{ path: [""] }, 400], [{ path: [join(dir, "missing.html")] }, 404], [{ path: [outside] }, 404],
      [{ path: [put(join(dir, "sub", "x.html"), "<p>x</p>")] }, 404], [{ path: [put(join(state, "visualizations", "not-a-session", "x.html"), "<p>x</p>")] }, 404],
      [{ path: [put(join(dir, "notes.txt"), "<p>x</p>")] }, 404], [{ path: [dir] }, 404], [{ path: [put(join(dir, "doc.html"), "<html><body></body></html>")] }, 422],
    ];
    if (linked) cases.push([{ path: [join(dir, "link-out.html")] }, 404], [{ path: [join(dir, "link-in.html")] }, 422]);
    for (const [query, status] of cases) assert.equal(visualizationReply(state, SKILL, query)![0], status, JSON.stringify(query));
    assert.equal(visualizationReply(join(state, "nowhere"), SKILL, { path: [real] })![0], 404);
    if (!linked) context.diagnostic("host refused symlink creation; the link cases are not covered here");
  });

  it("is a round-8 GET route that follows the skills plugin switch", async () => {
    const file = put(join(dir, "switch.html"), "<p>x</p>");
    let skills = true;
    const round8 = createRound8({ projectRoot: PROJECT_ROOT, stateDir: state, enabled: (id) => id !== "skills" || skills });
    assert.ok(round8.owns("GET", ["api", "visualizations"]) && round8.routes.includes("GET /api/visualizations"));
    assert.equal((await round8.dispatch("GET", ["api", "visualizations"], { path: [file] }, {}))![0], 200);
    assert.equal((await round8.dispatch("POST", ["api", "visualizations"], { path: [file] }, {}))![0], 405);
    skills = false;
    assert.equal((await round8.dispatch("GET", ["api", "visualizations"], { path: [file] }, {}))![0], 403);
  });

  it("sends a route's extra headers with the standard ones", async () => {
    const server = createServer((_req, res) => sendBody(res, 200, Buffer.from("<p>x</p>"), "text/html; charset=utf-8", { headers: { ...VISUALIZATION_HEADERS, "Content-Type": "text/plain" } }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
      assert.equal(response.headers.get("content-security-policy"), VISUALIZATION_HEADERS["Content-Security-Policy"]);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8", "the standard headers win");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(await response.text(), "<p>x</p>");
    } finally { server.close(); }
  });
});
