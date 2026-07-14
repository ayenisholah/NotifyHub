import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoPublic = path.join(root, 'packages', 'demo-host', 'public');
const dashboardPublic = path.join(root, 'packages', 'dashboard', 'public');
const templates = path.join(root, 'scripts', 'seo-assets');

async function available(fileName) {
  try {
    await access(fileName);
    return true;
  } catch {
    return false;
  }
}

async function executablePath() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  }
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  return process.platform === 'win32' && (await available(edge)) ? edge : undefined;
}

await mkdir(demoPublic, { recursive: true });
await mkdir(dashboardPublic, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: await executablePath() });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  for (const [template, destination] of [
    ['demo-social.html', path.join(demoPublic, 'social-demo.png')],
    ['dashboard-social.html', path.join(dashboardPublic, 'social-dashboard.png')],
  ]) {
    await page.setContent(await readFile(path.join(templates, template), 'utf8'), {
      waitUntil: 'load',
    });
    await page.screenshot({ path: destination, animations: 'disabled' });
  }

  const icon = await readFile(path.join(demoPublic, 'favicon.svg'), 'utf8');
  for (const [size, filename] of [
    [16, 'favicon-16x16.png'],
    [32, 'favicon-32x32.png'],
    [180, 'apple-touch-icon.png'],
    [192, 'icon-192x192.png'],
    [512, 'icon-512x512.png'],
  ]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>*{box-sizing:border-box}html,body{width:${size}px;height:${size}px;margin:0;overflow:hidden;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${icon}`,
      { waitUntil: 'load' },
    );
    await page.screenshot({
      path: path.join(demoPublic, filename),
      animations: 'disabled',
      omitBackground: true,
    });
  }
} finally {
  await browser.close();
}

console.log('Generated deterministic NotifyHub social cards and application icons.');
