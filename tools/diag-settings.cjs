const path = require("node:path");
const { chromium } = require(path.join(__dirname, "..", "webapp", "node_modules", "playwright"));

const BASE = process.env.XN_BASE || "http://127.0.0.1:8137/";

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + (e.stack || e.message)));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/Failed to load resource/i.test(msg.text())) {
      errs.push("CONSOLE: " + msg.text());
    }
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const btn = page.locator('[data-testid="task-settings-button"]').first();
  console.log("settings button count:", await btn.count());
  await btn.click();
  await page.waitForTimeout(3000);

  const state = await page.evaluate(() => {
    const ids = [...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid"));
    const settingsNavLike = ids.filter((t) => /settings/i.test(t));
    const page_ = document.querySelector('[data-testid="settings-page"]');
    return {
      totalTestIds: ids.length,
      settingsNavLike: settingsNavLike.slice(0, 40),
      settingsPagePresent: Boolean(page_),
      settingsPageText: page_ ? (page_.innerText || "").replace(/\s+/g, " ").slice(0, 500) : null,
      bodyText: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 400),
    };
  });
  console.log(JSON.stringify(state, null, 2));

  console.log("\n=== ERRORS ===");
  const seen = new Set();
  for (const e of errs) {
    const k = e.slice(0, 160);
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(e);
    console.log("---");
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
