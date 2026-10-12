import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Fetch is the external HTTP boundary; the child runs the real manifest and checker.
test('download link checker covers the published Linux formats and prerequisites', () => {
    const checker = new URL('./check-download-links.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
        const checked = [];
        globalThis.fetch = async (url) => {
            checked.push(String(url));
            return { status: 200 };
        };
        await import(${JSON.stringify(checker)});
        console.log('CHECKED_LINKS=' + JSON.stringify(checked));
    `], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.split('\n').find((value) => value.startsWith('CHECKED_LINKS='));
    assert.ok(line, 'the real checker completed');
    const checked = JSON.parse(line.slice('CHECKED_LINKS='.length));
    const base = 'https://github.com/happier-dev/happier/releases/download/ui-desktop-stable/';
    for (const file of [
        'happier-ui-desktop-linux-x86_64.AppImage',
        'happier-ui-desktop-linux-x86_64.deb',
        'happier-ui-desktop-linux-x86_64.rpm',
    ]) assert.ok(checked.includes(base + file), file);
    assert.ok(checked.includes('https://docs.happier.dev/getting-started/get-the-apps#linux-appimage-prerequisites'));
});
