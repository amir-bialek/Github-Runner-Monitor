// Captures the README screenshots from a running demo (Story 8.5).
//
// Not run in CI. The screenshots for a major version live in docs/images/vN;
// rerun this when the dashboard changes in a way the pictures should show.
//
// 1. Start the demo: invented data, Debug it on, nothing calls GitHub or
//    Anthropic. In two terminals:
//
//      cd code/backend && npm ci && \
//        USE_MOCK_DATA=true DEBUG_IT_ENABLED=true \
//        DEBUG_IT_PUBLIC_URL=http://localhost:3000 npm start
//      cd code/frontend && npm ci && npx vite
//
//    Wait about 11 minutes after the backend starts: the demo's offline
//    runner pool raises its alert after the default 10 minute threshold, so
//    the Alerts window then shows both alert kinds.
//    Use a freshly started backend for every capture: the script starts a
//    debug run, and on a second capture that row would show "View debug run".
//
//    (or `docker compose -f docker/docker-compose.yml up --build -d` and pass
//    http://localhost:8080 as the address below).
//
// 2. With Playwright and Chromium installed (globally, or `npx playwright`
//    anywhere outside the app packages; it is not an app dependency):
//
//      node docs/images/capture-screenshots.mjs docs/images/v2 [http://localhost:3000]
//
// It writes, at twice the pixel density, in the light theme:
//   dashboard-light.png   the whole dashboard, signed in as the demo user
//   side-panel.png        the side panel (nav "Main"): the heading, Dashboard,
//                         Alerts, Debug it settings, Security, the theme
//                         switch, the signed in user and Sign out
//   alerts-popover.png    the side panel with the Alerts window open beside it
//   alert-settings.png    the Alert settings dialog
//   security-page.png     the Security page
//   debug-it-pipeline.png the Debug run dialog of that run at Analyzing, with
//                         Waiting and Cloning ticked
//   debug-it-result.png   a finished demo debug run with its invented result
//
// Every name in the pictures is the demo's invented data (acme, dana, ...).
// Look at each PNG before committing it.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// An ESM import does not search NODE_PATH or the global packages, so fall
// back to require() when Playwright is installed globally.
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return createRequire(import.meta.url)('playwright');
  }
}

const [outDir, baseUrl = 'http://localhost:3000'] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node docs/images/capture-screenshots.mjs <output folder> [dashboard address]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const out = (name) => path.join(outDir, name);

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1520, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
  reducedMotion: 'reduce',
});
const page = await context.newPage();

// A full page picture with the window as tall as the page, so the fixed side
// panel reaches the bottom of the picture (fullPage alone leaves it at 900px).
async function fullPage(name) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 1520, height });
  await page.waitForTimeout(400);
  await page.screenshot({ path: out(name) });
  await page.setViewportSize({ width: 1520, height: 900 });
  await page.waitForTimeout(200);
}

try {
  // Sign in: in demo mode this always signs in the invented user dana.
  await page.goto(baseUrl);
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
  await page.getByRole('button', { name: /^Debug it:/ }).first().waitFor();
  await page.waitForLoadState('networkidle');

  await fullPage('dashboard-light.png');
  const panel = page.getByRole('navigation', { name: 'Main' });
  await panel.screenshot({ path: out('side-panel.png') });
  // Measured now: while the Alerts window is open the panel is aria-hidden.
  const panelBox = await panel.boundingBox();

  // Alerts window: the side panel and the window beside it.
  await panel.getByRole('button', { name: /^Alerts/ }).click();
  const popover = page.locator('.MuiPopover-paper');
  await popover.waitFor();
  await page.waitForTimeout(400);
  const box = await popover.boundingBox();
  await page.screenshot({
    path: out('alerts-popover.png'),
    clip: {
      x: 0,
      y: 0,
      width: Math.min(1520, Math.ceil(box.x + box.width + 24)),
      height: Math.ceil(Math.max(panelBox.y + panelBox.height, box.y + box.height + 24)),
    },
  });

  // Alert settings dialog.
  await popover.getByRole('button', { name: 'Alert settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Alert settings' });
  await settings.waitFor();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  await settings.screenshot({ path: out('alert-settings.png') });
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });

  // Security page.
  await panel.getByRole('button', { name: 'Security', exact: true }).click();
  await page.getByRole('heading', { name: 'Debug it security' }).waitFor();
  await page.waitForLoadState('networkidle');
  await fullPage('security-page.png');
  await page.getByRole('button', { name: 'Back to dashboard' }).first().click();
  await page.getByRole('button', { name: /^Debug it:/ }).first().waitFor();

  // A Debug it run: the demo moves it to a fixed, invented result in a few
  // seconds. A tall window keeps the whole result visible in the dialog.
  await page.setViewportSize({ width: 1520, height: 2400 });
  await page.getByRole('button', { name: /^Debug it:/ }).first().click();
  const run = page.getByRole('dialog', { name: 'Debug run' });

  // The pipeline at Analyzing. Each demo step lasts a few seconds, shorter
  // than the dialog's 5 second poll, so a visibilitychange event once a
  // second makes the dialog fetch the run again until it reads Analyzing.
  const status = run.getByRole('status');
  const deadline = Date.now() + 60_000;
  while (!/^Analyzing$/.test(((await status.textContent().catch(() => '')) ?? '').trim())) {
    if (Date.now() > deadline) throw new Error('The debug run never showed Analyzing.');
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(1000);
  }
  // The short dialog sits at a fractional height in the tall window, so the
  // picture is cut on whole pixels inside it, without the page behind.
  const runBox = await run.boundingBox();
  const top = Math.ceil(runBox.y);
  const left = Math.ceil(runBox.x);
  await page.screenshot({
    path: out('debug-it-pipeline.png'),
    clip: {
      x: left,
      y: top,
      width: Math.floor(runBox.x + runBox.width) - left,
      height: Math.floor(runBox.y + runBox.height) - top,
    },
  });

  await run.getByText('The debug run finished.').waitFor({ timeout: 60_000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await run.screenshot({ path: out('debug-it-result.png') });
} finally {
  await browser.close();
}

console.log(`Screenshots written to ${outDir}`);
