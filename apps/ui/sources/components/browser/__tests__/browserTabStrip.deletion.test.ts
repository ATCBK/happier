import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(here, '../../../../');
const sourcesRoot = path.join(uiRoot, 'sources');

/**
 * Guard for D2-revised: the browser is a CONSUMER of the single details-workspace tab engine.
 * The bespoke `BrowserTabStrip` and the parallel browser ordering authority
 * (`orderedViewIdsBySessionId` / `focusedViewIdBySessionId` / `selectBrowserTabs` /
 * `selectFocusedBrowserView`) must be gone with zero non-test importers — there is exactly one
 * tab system, host-owned.
 */
function nonTestSourceFiles(): string[] {
    return readdirSync(sourcesRoot, { recursive: true, encoding: 'utf8' })
        .map((relative) => relative.split(path.sep).join('/'))
        .filter((relative) => /\.[cm]?[jt]sx?$/u.test(relative))
        .filter((relative) => !/\.test\.[^/]*$/u.test(relative) && !relative.split('/').includes('__tests__'))
        .filter((relative) => !relative.split('/').includes('node_modules'));
}

let nonTestSourceLines: ReadonlyArray<readonly [location: string, line: string]> | null = null;

/** Matching non-test source lines, as `file:line` entries; empty when the pattern is fully retired. */
function grepNonTest(pattern: string): string {
    // One read of the tree serves every pattern; the guard only needs the text once.
    nonTestSourceLines ??= nonTestSourceFiles().flatMap((relative) => readFileSync(path.join(sourcesRoot, relative), 'utf8')
        .split('\n').map((line, index) => [`${relative}:${index + 1}`, line] as const));
    return nonTestSourceLines.filter(([, line]) => line.includes(pattern)).map(([location]) => location).join('\n');
}

describe('BrowserTabStrip retirement', () => {
    it('removes the bespoke BrowserTabStrip file', () => {
        expect(existsSync(path.join(sourcesRoot, 'components/browser/BrowserTabStrip.tsx'))).toBe(false);
    });

    it('has zero non-test importers of BrowserTabStrip', () => {
        expect(grepNonTest('BrowserTabStrip')).toBe('');
    });

    it('has zero non-test references to the retired browser ordering authority', () => {
        expect(grepNonTest('selectBrowserTabs')).toBe('');
        expect(grepNonTest('selectFocusedBrowserView')).toBe('');
        expect(grepNonTest('orderedViewIdsBySessionId')).toBe('');
        expect(grepNonTest('focusedViewIdBySessionId')).toBe('');
    });
});
