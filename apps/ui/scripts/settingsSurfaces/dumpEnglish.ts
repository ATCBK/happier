/**
 * Flattens the English translation tree to `{ "a.b.c": "text" }` (functions become `null`) so the
 * settings-surface codemods can judge label length and resolve copy without importing app code.
 *
 *   pnpm exec tsx scripts/settingsSurfaces/dumpEnglish.ts <out.json>
 */
import { writeFileSync } from 'node:fs';

import { en } from '../../sources/text/translations/en';

const out: Record<string, string | null> = {};
const visit = (node: unknown, prefix: string): void => {
    if (typeof node === 'string') { out[prefix] = node; return; }
    if (typeof node === 'function') { out[prefix] = null; return; }
    if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) visit(value, prefix ? `${prefix}.${key}` : key);
    }
};
visit(en, '');
writeFileSync(process.argv[2] ?? '/dev/stdout', JSON.stringify(out));
