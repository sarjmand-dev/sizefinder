// به‌روزرسانی خودکار products.json و عکس‌های کوچک محصولات — اجرا در GitHub Actions (یا هر کامپیوتری با Node.js)
//   npm i playwright && npx playwright install chromium && node scraper/run.mjs
import { chromium } from "playwright";
import fs from "node:fs";

const SITE = process.env.LW_SITE || "https://lovewearz.ir";
const MIN_PRODUCTS = 20;   // اگر کمتر از این پیدا شد، فایل قبلی دست نمی‌خورد (محافظ در برابر خرابی سایت)
const THUMB_W = 360;       // عرض عکس کوچک (پیکسل)

const root = new URL("../", import.meta.url);
const code = fs.readFileSync(new URL("./lw-scraper.js", import.meta.url), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage({ locale: "fa-IR" });
await page.goto(SITE + "/", { waitUntil: "domcontentloaded", timeout: 90000 });
await page.evaluate(code);
const res = await page.evaluate(() => window.LWScraper.scrape({ concurrency: 6 }));

console.log(`scanned=${res.scanned} products=${res.products.length} problems=${res.problems.length}`);
if (res.products.length < MIN_PRODUCTS) {
  console.error("تعداد محصولات کمتر از حد انتظار است؛ فایل به‌روزرسانی نشد.");
  await browser.close();
  process.exit(1);
}

/* ---------- عکس‌های کوچک: روی همین مخزن ذخیره می‌شوند تا نمایششان به سایت وابسته نباشد ---------- */
const thumbsDir = new URL("thumbs/", root);
fs.mkdirSync(thumbsDir, { recursive: true });
const idxFile = new URL("thumbs/index.json", root);
let idx = {};
try { idx = JSON.parse(fs.readFileSync(idxFile, "utf8")); } catch (e) {}
const safe = c => String(c).replace(/[^A-Za-z0-9_-]/g, "_");

for (const p of res.products) {
  if (!p.img) continue;
  const name = safe(p.code) + ".jpg";
  const file = new URL(name, thumbsDir);
  if (idx[p.code] !== p.img || !fs.existsSync(file)) {
    try {
      const b64 = await page.evaluate(async ({ url, w }) => {
        const blob = await (await fetch(url, { cache: "no-store" })).blob();
        const bmp = await createImageBitmap(blob);
        const h = Math.round(bmp.height * w / bmp.width);
        const c = new OffscreenCanvas(w, h);
        c.getContext("2d").drawImage(bmp, 0, 0, w, h);
        const out = await c.convertToBlob({ type: "image/jpeg", quality: 0.82 });
        const buf = new Uint8Array(await out.arrayBuffer());
        let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(s);
      }, { url: p.img, w: THUMB_W });
      fs.writeFileSync(file, Buffer.from(b64, "base64"));
      idx[p.code] = p.img;
    } catch (e) {
      console.warn("thumb failed", p.code, e.message);
      continue;
    }
  }
  p.thumb = "thumbs/" + name;
}
fs.writeFileSync(idxFile, JSON.stringify(idx, null, 1));
await browser.close();

/* ---------- ذخیره‌ی داده (اگر جز زمان، چیزی تغییر نکرده، بازنویسی نکن) ---------- */
const file = new URL("products.json", root);
let changed = true;
try {
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  const strip = o => JSON.stringify({ ...o, generatedAt: 0 });
  changed = strip(old) !== strip(res);
} catch (e) {}
if (changed) fs.writeFileSync(file, JSON.stringify(res, null, 1));
else console.log("داده‌ها بدون تغییر.");

/* ---------- گزارش برای صاحب سایت ---------- */
const lines = [
  `# گزارش به‌روزرسانی سایزیاب`,
  ``,
  `- زمان: ${res.generatedAt}`,
  `- منبع: ${SITE}`,
  `- صفحات بررسی‌شده: ${res.scanned}`,
  `- محصولات دارای جدول سایز: ${res.products.length}`,
  `- عکس‌های ذخیره‌شده: ${res.products.filter(p => p.thumb).length}`,
  ``,
  res.problems.length ? `## موارد نیازمند بررسی (${res.problems.length})` : `هیچ مشکلی پیدا نشد ✓`,
  ...res.problems.map(p => `- [${p.code}](${p.url}) ${p.name} — ${p.issue}`),
];
fs.writeFileSync(new URL("update-report.md", root), lines.join("\n") + "\n");
