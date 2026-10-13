import { chromium } from "@playwright/test";
import { readdirSync } from "node:fs";
const dir = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 675 }, deviceScaleFactor: 2 });
for (const file of readdirSync(dir).filter((f) => f.endsWith(".html"))) {
  await page.goto(`file://${dir}/${file}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() => [document.fonts.check('800 60px "Satoshi"'), document.fonts.check('500 17px "DM Mono"')]);
  await page.screenshot({ path: `${dir}/../${file.replace(".html", ".png")}` });
  console.log(file, "fonts loaded:", fonts.join(","));
}
await browser.close();
