/*
 * LoveWearz scraper — جمع‌آوری جدول سایز، قیمت و موجودی سوتین‌ها و ست‌ها از lovewearz.ir
 *
 * این فایل باید داخل صفحه‌ای از خود lovewearz.ir اجرا شود (هم‌مبدأ)، به یکی از این دو روش:
 *   1) GitHub Actions با Playwright  (scraper/run.mjs)
 *   2) بوکمارکلت صفحه‌ی admin.html   (LWScraper.runAndDownload)
 * خروجی: { generatedAt, source, products: [...], problems: [...] }
 */
(function (global) {
  "use strict";

  const clean = s => String(s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  const enDigits = s => String(s)
    .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));

  /* «80/5تا 83» ، «از 74.5 تا 78.5» ، «75تا 74» (برعکس) → [80.5, 83] */
  function parseRange(s) {
    const n = (enDigits(s).match(/\d+(?:[./]\d+)?/g) || []).map(x => parseFloat(x.replace("/", ".")));
    if (n.length !== 2) return null;
    n.sort((a, b) => a - b);
    if (n[1] - n[0] > 15 || n[0] < 40 || n[1] > 160) return null;
    return n;
  }

  const COLS = {
    label: /سایز روی|سایز محصول/,
    under: /زیر ?سینه/,
    over: /روی ?سینه/,
    cup: /کاپ/,
    ir: /ایرانی/,
  };

  function parseSizeTable(doc) {
    const scope = doc.querySelector("#home-tab-pane") || doc.querySelector(".description") || doc;
    for (const tb of scope.querySelectorAll("table")) {
      const rows = [...tb.querySelectorAll("tr")].map(tr => [...tr.querySelectorAll("td,th")].map(c => clean(c.textContent)));
      const hi = rows.findIndex(r => r.some(c => COLS.under.test(c)));
      if (hi < 0) continue;
      const h = rows[hi];
      const idx = {};
      for (const k in COLS) idx[k] = h.findIndex(c => COLS[k].test(c) && !(k === "over" && COLS.under.test(c)));
      if (idx.label < 0) idx.label = 0;
      const sizes = [], bad = [];
      for (const r of rows.slice(hi + 1)) {
        if (!r.some(Boolean)) continue;
        const under = parseRange(r[idx.under]), over = parseRange(r[idx.over]);
        const row = {
          label: r[idx.label] || "",
          under, over,
          cup: idx.cup >= 0 ? (r[idx.cup] || "").toUpperCase() : "",
          ir: idx.ir >= 0 ? enDigits(r[idx.ir] || "") : "",
        };
        if (!under || !over || over[0] < under[0]) bad.push(r.join(" | "));
        else sizes.push(row);
      }
      return { sizes, bad };
    }
    return null;
  }

  function parseVariants(doc) {
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      let j; try { j = JSON.parse(s.textContent); } catch (e) { continue; }
      const g = [].concat(j).find(x => x && x["@type"] === "ProductGroup");
      if (!g) continue;
      return (g.hasVariant || []).map(v => {
        const parts = String(v.name || "").split(" - ");
        const o = v.offers || {};
        return {
          c: parts.length > 2 ? clean(parts[parts.length - 2]) : "",
          s: clean(parts[parts.length - 1] || ""),
          p: Math.round((+o.price || 0) / 10),               // ریال → تومان
          a: /InStock/i.test(o.availability || ""),
          url: o.url || v.url || "",
        };
      });
    }
    return [];
  }

  /* جدول «مشخصات» محصول: نوع، میزان پوشش، بند سرشانه، مناسب برای، جنس و ... */
  function parseSpecs(doc) {
    const tb = doc.querySelector("#profile-tab-pane table");
    const o = {};
    if (!tb) return o;
    for (const tr of tb.querySelectorAll("tr")) {
      const k = clean(tr.querySelector("th")?.textContent), v = clean(tr.querySelector("td")?.textContent);
      if (k && v && !/سایز/.test(k)) o[k] = v;
    }
    return o;
  }

  const looksLikeBra = name => /سوتین|ست |^ست|برالت|کرست|بالکنت/.test(name);

  async function fetchDoc(url) {
    const r = await fetch(url, { credentials: "omit", cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return new DOMParser().parseFromString(await r.text(), "text/html");
  }

  async function productUrls(origin) {
    const idx = await (await fetch(origin + "/sitemap.xml", { cache: "no-store" })).text();
    const maps = [...idx.matchAll(/<loc>([^<]*sitemap-products[^<]*)<\/loc>/g)].map(m => m[1].trim());
    const urls = new Set();
    for (const m of maps) {
      const x = await (await fetch(m, { cache: "no-store" })).text();
      for (const mm of x.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.add(mm[1].trim());
    }
    return [...urls];
  }

  async function scrape(opts = {}) {
    const origin = opts.origin || location.origin;
    const conc = opts.concurrency || 6;
    const onProgress = opts.onProgress || (() => {});
    const urls = await productUrls(origin);
    const products = [], problems = [];
    let done = 0;

    async function one(url) {
      try {
        const doc = await fetchDoc(url);
        const name = clean(doc.querySelector("h1")?.textContent);
        const code = decodeURIComponent(url.split("/product/")[1] || "").split("?")[0];
        const table = parseSizeTable(doc);
        if (!table) {
          if (looksLikeBra(name)) problems.push({ code, name, url, issue: "جدول سایز در توضیحات پیدا نشد" });
          return;
        }
        if (table.bad.length) problems.push({ code, name, url, issue: "ردیف‌های ناخوانا: " + table.bad.join(" / ") });
        if (!table.sizes.length) return;
        const vars = parseVariants(doc);
        const prices = vars.filter(v => v.p).map(v => v.p);
        products.push({
          code, name, url,
          type: /^ست/.test(name) ? "ست" : "سوتین",
          img: doc.querySelector('meta[property="og:image"]')?.content || "",
          price: prices.length ? Math.min(...prices) : 0,
          sizes: table.sizes,
          specs: parseSpecs(doc),
          vars,
        });
      } catch (e) {
        problems.push({ code: url, name: "", url, issue: "خطا در خواندن صفحه: " + e.message });
      } finally {
        onProgress(++done, urls.length);
      }
    }

    for (let i = 0; i < urls.length; i += conc) await Promise.all(urls.slice(i, i + conc).map(one));
    const order = new Map(urls.map((u, i) => [u, i]));
    products.sort((a, b) => order.get(a.url) - order.get(b.url));
    return { generatedAt: new Date().toISOString(), source: origin, scanned: urls.length, products, problems };
  }

  /* اجرای دستی با بوکمارکلت روی lovewearz.ir: نوار پیشرفت + دانلود products.json */
  async function runAndDownload() {
    if (!/lovewearz\.(ir|com)$/.test(location.hostname)) { alert("این ابزار را روی سایت lovewearz.ir اجرا کنید."); return; }
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;inset:auto 16px 16px auto;z-index:999999;background:#564243;color:#fff;padding:14px 18px;border-radius:12px;font:14px Tahoma;direction:rtl;box-shadow:0 6px 24px #0004";
    box.textContent = "در حال خواندن فهرست محصولات…";
    document.body.appendChild(box);
    try {
      const res = await scrape({ onProgress: (d, t) => box.textContent = `در حال خواندن محصولات: ${d} از ${t}` });
      const blob = new Blob([JSON.stringify(res, null, 1)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "products.json";
      document.body.appendChild(a); a.click();
      box.innerHTML = `تمام شد ✓ ${res.products.length} محصول با جدول سایز` +
        (res.problems.length ? `<br>${res.problems.length} مورد نیاز به بررسی (داخل فایل، بخش problems)` : "") +
        `<br>فایل products.json دانلود شد.`;
    } catch (e) {
      box.textContent = "خطا: " + e.message;
    }
    setTimeout(() => box.remove(), 20000);
  }

  global.LWScraper = { scrape, runAndDownload, parseRange, parseSizeTable, parseVariants, parseSpecs };
})(typeof window !== "undefined" ? window : globalThis);
