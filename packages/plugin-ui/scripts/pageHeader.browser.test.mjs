import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const uiModules = resolve(repositoryRoot, 'apps/ui/node_modules');

test('PageHeader actions remain clickable and mounted through wrapped, wide and phone layouts', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: resolve(repositoryRoot, 'packages/plugin-ui'),
      sourcefile: 'pageHeader.browser.fixture.tsx', loader: 'tsx',
      contents: `
        import { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { Pressable, Text, View } from 'react-native';
        import { HappierPageHeader } from './src/presentation/layout/PageHeader.tsx';
        function Action() {
          const [count, setCount] = useState(0);
          return <Pressable testID="action" accessibilityRole="button" onPress={() => setCount(n => n + 1)}
            style={{ width: 242, height: 32 }}><Text>{'Run on · ' + count}</Text></Pressable>;
        }
        createRoot(document.getElementById('root')).render(
          <HappierPageHeader testID="header" title="Azure DevOps source settings"
            description="Choose the source used for this Home."
            compactPresentation="centered" leading={<View style={{ width: 64, height: 64 }} />}
            actions={<Action />} />);
      `,
    },
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
    bundle: true, write: false, jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { react: resolve(uiModules, 'react'), 'react-dom': resolve(uiModules, 'react-dom'),
      'react-native': resolve(uiModules, 'react-native-web') },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 844 } });
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByTestId('action').waitFor();
    await page.getByTestId('action').evaluate(element => { window.originalAction = element; });
    let count = 0;
    for (const [width, wrapped] of [[1200, false], [650, true], [390, false], [650, true], [1200, false]]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForFunction(expected => Boolean(document.querySelector('[data-testid="header-actions-below"]')) === expected, wrapped);
      // ResizeObserver delivers RNW's actual measurements; let their React commits paint.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const hit = await page.getByTestId('action').evaluate(element => {
        const rect = element.getBoundingClientRect();
        const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { sameNode: element === window.originalAction, hit: element.contains(target),
          count: document.querySelectorAll('[data-testid="action"]').length };
      });
      assert.deepEqual(hit, { sameNode: true, hit: true, count: 1 }, `action hit testing at ${width}px`);
      await page.getByTestId('action').click();
      count += 1;
      assert.equal(await page.getByTestId('action').textContent(), `Run on · ${count}`);
    }
  } finally {
    await browser.close();
  }
});
