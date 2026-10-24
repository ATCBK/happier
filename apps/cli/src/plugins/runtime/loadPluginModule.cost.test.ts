import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({ transforms: [] as string[] }));
// Count work at the real third-party compiler boundary; keep evaluation real.
vi.mock('jiti', async (importOriginal) => {
    const actual = await importOriginal<typeof import('jiti')>();
    return {
        ...actual,
        createJiti: ((id, options = {}) => {
            const transform = actual.createJiti(id, options).options.transform!;
            return actual.createJiti(id, {
                ...options,
                transform(input) {
                    observed.transforms.push(input.filename ?? '<unknown>');
                    return transform(input);
                },
            });
        }) satisfies typeof actual.createJiti,
    };
});

import { createPluginTypeScriptCandidateScope, loadVerifiedPluginModule } from './loadPluginModule';

it('does not transform unchanged candidate bytes again and still observes same-size source edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-evaluator-cost-'));
    const entry = join(root, 'index.ts');
    try {
        await mkdir(join(root, 'children'));
        await writeFile(entry, 'export { value } from "./children/value.ts";');
        const child = join(root, 'children/value.ts');
        await writeFile(child, 'export const value: number = 1;');
        const load = async () => loadVerifiedPluginModule({
            entryPath: entry,
            loadMode: 'source-ts',
            generationScope: await createPluginTypeScriptCandidateScope({ rootPath: root }),
        });
        expect(await load()).toMatchObject({ value: 1 });
        expect(observed.transforms).toContain(child);
        observed.transforms = [];
        expect(await load()).toMatchObject({ value: 1 });
        expect(observed.transforms).toEqual([]);
        await writeFile(child, 'export const value: number = 2;');
        observed.transforms = [];
        expect(await load()).toMatchObject({ value: 2 });
        expect(observed.transforms).toEqual([child]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
