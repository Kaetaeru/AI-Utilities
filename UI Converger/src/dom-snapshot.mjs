import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

export async function captureDomSnapshot(url, { width = 1440, height = 1000, screenshotPath = null } = {}) {
  const target = new URL(String(url));
  if (!/^https?:$/.test(target.protocol)) throw new Error("Preview URL must use http or https");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: clamp(width, 320, 3840), height: clamp(height, 320, 2160) } });
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(800);
    const snapshot = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("body *"));
      const candidates = [];
      for (const element of nodes) {
        const rect = element.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
        const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        const semantic = /^(HEADER|NAV|MAIN|ASIDE|SECTION|ARTICLE|BUTTON|INPUT|TEXTAREA|SELECT|A|H1|H2|H3|H4|H5|H6|P|LABEL|IMG)$/.test(element.tagName)
          || element.hasAttribute("role") || element.id || text.length > 0;
        if (!semantic) continue;
        candidates.push({
          tag: element.tagName.toLowerCase(),
          id: element.id || null,
          role: element.getAttribute("role"),
          classes: Array.from(element.classList || []).slice(0, 12),
          text: text.slice(0, 240),
          rect: { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) },
          style: {
            display: style.display, position: style.position, fontSize: style.fontSize, fontWeight: style.fontWeight,
            lineHeight: style.lineHeight, color: style.color, backgroundColor: style.backgroundColor,
            borderRadius: style.borderRadius, padding: style.padding, margin: style.margin, gap: style.gap,
            justifyContent: style.justifyContent, alignItems: style.alignItems, gridTemplateColumns: style.gridTemplateColumns
          }
        });
        if (candidates.length >= 650) break;
      }
      return {
        title: document.title,
        url: location.href,
        viewport: { width: innerWidth, height: innerHeight },
        body: { width: document.body.scrollWidth, height: document.body.scrollHeight, backgroundColor: getComputedStyle(document.body).backgroundColor },
        elements: candidates
      };
      function round(value) { return Math.round(value * 10) / 10; }
    });
    if (screenshotPath) {
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: false });
      snapshot.screenshot_path = screenshotPath;
    }
    return snapshot;
  } finally {
    await browser.close();
  }
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.floor(number)));
}
