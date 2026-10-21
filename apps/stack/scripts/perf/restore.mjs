// Adapted from providers-audit/qa-r2c42/restore.mjs. Secret enters only stdin;
// no error message, argument or browser snapshot can echo its value.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../../packages/tests/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
let key = '';
let browser, page;
let phase = 'stdin';
try {
  for await (const chunk of process.stdin) key += chunk;
  if (!key.trim()) throw new Error();
  phase = 'attach';
  browser = await chromium.connectOverCDP(process.env.PERF_CDP);
  page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith(process.env.PERF_ORIGIN + '/'));
  if (!page) throw new Error();
  phase = 'password-input';
  const input = page.getByTestId('restore-manual-secret-input');
  if (await input.getAttribute('type') !== 'password') throw new Error();
  phase = 'fill';
  await input.fill(key.trim()); key = '';
  phase = 'submit';
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  phase = 'completion';
  await input.waitFor({ state: 'detached', timeout: 120000 });
} catch { console.error(`Restore did not complete (${phase}); sensitive locator diagnostics suppressed`); process.exitCode = 1; }
finally {
  key = '';
  if (page) try { const input = page.getByTestId('restore-manual-secret-input'); if (await input.count()) await input.fill(''); } catch {}
  await browser?.close();
}
