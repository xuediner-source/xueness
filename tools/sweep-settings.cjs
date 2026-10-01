const path = require("node:path");
const { chromium } = require(path.join(__dirname, "..", "webapp", "node_modules", "playwright"));

const BASE = process.env.XN_BASE || "http://127.0.0.1:8137/";

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  // 按分区归集：当前激活分区由脚本设置，所有报错都挂到它名下。
  let currentSection = "(boot)";
  const errorsBySection = new Map();
  const addError = (kind, text) => {
    const key = currentSection;
    if (!errorsBySection.has(key)) errorsBySection.set(key, []);
    errorsBySection.get(key).push({ kind, text: String(text).slice(0, 300) });
  };

  page.on("pageerror", (e) => addError("pageerror", e.message));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const t = msg.text();
    // 过滤静态资源/网络噪音之外，其余全部保留
    if (/Failed to load resource/i.test(t)) return;
    addError("console", t);
  });
  page.on("requestfailed", (req) => {
    const u = req.url();
    if (/\/api\//.test(u)) addError("requestfailed", `${u} :: ${req.failure()?.errorText}`);
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  currentSection = "(boot)";
  // 打开设置
  const settingsBtn = page.locator('[data-testid="task-settings-button"]').first();
  if (await settingsBtn.count() === 0) {
    console.log("FATAL: task-settings-button not found");
    await browser.close();
    process.exit(1);
  }
  await settingsBtn.click();
  await page.waitForTimeout(2500);

  // 收集所有分区导航按钮
  const sections = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-testid^="settings-section-nav-"]')) {
      out.push({
        id: el.getAttribute("data-testid").replace("settings-section-nav-", ""),
        label: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 30),
      });
    }
    return out;
  });
  console.log(`=== 发现 ${sections.length} 个分区 ===`);
  console.log(JSON.stringify(sections, null, 2));

  const renderedBySection = [];
  for (const s of sections) {
    currentSection = s.id;
    const before = errorsBySection.get(currentSection)?.length || 0;
    const nav = page.locator(`[data-testid="settings-section-nav-${s.id}"]`).first();
    try {
      await nav.click({ timeout: 5000 });
      await page.waitForTimeout(1800);
    } catch (e) {
      addError("nav-click", e.message);
      continue;
    }
    // 抓该分区主内容区的可见文本，用来判断是「空壳」还是「有内容」
    const info = await page.evaluate((id) => {
      const root = document.querySelector('[data-testid="settings-page"]');
      const txt = root ? (root.innerText || "").replace(/\s+/g, " ").trim() : "";
      // 报错横幅/空态关键词
      const errLike = /(出错|错误|失败|无法|未实现|暂不|not implemented|failed|error|Something went wrong)/i.test(txt);
      return { len: txt.length, errLike, head: txt.slice(0, 220) };
    }, s.id);
    const after = errorsBySection.get(currentSection)?.length || 0;
    renderedBySection.push({ ...s, contentLen: info.len, errLikeText: info.errLike, newErrors: after - before, head: info.head });
  }

  console.log("\n=== 分区渲染结果 ===");
  for (const r of renderedBySection) {
    console.log(`${r.newErrors > 0 ? "✗" : "✓"} ${r.id.padEnd(20)} len=${String(r.contentLen).padStart(5)} 页面含报错词=${r.errLikeText} 新报错=${r.newErrors}`);
    if (r.head) console.log(`     head: ${r.head}`);
  }

  console.log("\n=== 报错明细（按分区）===");
  for (const [sec, errs] of errorsBySection) {
    if (!errs.length) continue;
    console.log(`\n--- ${sec} (${errs.length}) ---`);
    // 去重
    const seen = new Set();
    for (const e of errs) {
      const k = e.kind + "|" + e.text.slice(0, 120);
      if (seen.has(k)) continue;
      seen.add(k);
      console.log(`  [${e.kind}] ${e.text.split("\n")[0]}`);
    }
  }

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
