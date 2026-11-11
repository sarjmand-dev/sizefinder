// به‌روزرسانی خودکار products.json — اجرا در GitHub Actions (یا هر کامپیوتری با Node.js)
//   npm i playwright && npx playwright install chromium && node scraper/run.mjs
import { chromium } from "playwright";
import fs from "node:fs";

const SITE = process.env.LW_SITE || "https://lovewearz.com";
const MIN_PRODUCTS = 20;   // اگر کمتر از این پیدا شد، فایل قبلی دست نمی‌خورد (محافظ در برابر خرابی سایت)

const code = fs.readFileSync(new URL("./lw-scraper.js", import.meta.url), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage({ locale: "fa-IR" });
await page.goto(SITE + "/", { waitUntil: "domcontentloaded", timeout: 90000 });
await page.evaluate(code);
const res = await page.evaluate(() => window.LWScraper.scrape({ concurrency: 6 }));
await browser.close();

console.log(`scanned=${res.scanned} products=${res.products.length} problems=${res.problems.length}`);
if (res.products.length < MIN_PRODUCTS) {
  console.error("تعداد محصولات کمتر از حد انتظار است؛ فایل به‌روزرسانی نشد.");
  process.exit(1);
}

// اگر جز زمان، چیزی تغییر نکرده، فایل را بازنویسی نکن (کامیت اضافه نسازد)
const file = new URL("../products.json", import.meta.url);
try {
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  const strip = o => JSON.stringify({ ...o, generatedAt: 0 });
  if (strip(old) === strip(res)) { console.log("بدون تغییر."); process.exit(0); }
} catch (e) {}
fs.writeFileSync(file, JSON.stringify(res, null, 1));

// گزارش برای صاحب سایت
const lines = [
  `# گزارش به‌روزرسانی سایزیاب`,
  ``,
  `- زمان: ${res.generatedAt}`,
  `- صفحات بررسی‌شده: ${res.scanned}`,
  `- محصولات دارای جدول سایز: ${res.products.length}`,
  ``,
  res.problems.length ? `## موارد نیازمند بررسی (${res.problems.length})` : `هیچ مشکلی پیدا نشد ✓`,
  ...res.problems.map(p => `- [${p.code}](${p.url}) ${p.name} — ${p.issue}`),
];
fs.writeFileSync(new URL("../update-report.md", import.meta.url), lines.join("\n") + "\n");
