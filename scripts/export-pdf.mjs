#!/usr/bin/env node
/**
 * Export bp-bubblebored.html to a landscape A4 PDF using headless Chromium.
 *
 * Why not browser print?  @media print introduces font hinting, minimum font
 * sizes, and default rule divergences that make the PDF drift from what you
 * see on screen.  Here we:
 *   1. Load the page in Puppeteer at an A4-landscape viewport.
 *   2. Inject body.export so the document uses the *screen* CSS path at the
 *      exact page content box (261 × 182mm).
 *   3. Force emulateMediaType('screen') so page.pdf() renders screen CSS.
 *   4. Rely on @page + break-after: page on each section for pagination.
 *
 * Usage:
 *   node scripts/export-pdf.mjs                 # default: bp-bubblebored.html → bp-bubblebored.pdf
 *   node scripts/export-pdf.mjs input.html output.pdf
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const input = path.resolve(process.argv[2] ?? 'bp-bubblebored.html');
const output = path.resolve(process.argv[3] ?? input.replace(/\.html?$/i, '.pdf'));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 }, // 16:9 @ 96dpi
  deviceScaleFactor: 2,
});
const page = await context.newPage();

await page.goto(pathToFileURL(input).href, { waitUntil: 'networkidle' });
await page.addStyleTag({ content: 'html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }' });
await page.evaluate(() => document.body.classList.add('export'));

// Wait for favicons / remote logos to settle.
await page.waitForLoadState('networkidle');
await page.waitForTimeout(300);

await page.emulateMedia({ media: 'screen' });

await page.pdf({
  path: output,
  width: '338mm',
  height: '190mm',
  printBackground: true,
  preferCSSPageSize: true,
  margin: { top: '12mm', right: '14mm', bottom: '12mm', left: '14mm' },
});

await browser.close();
console.log(`✔  ${path.relative(process.cwd(), output)}`);
