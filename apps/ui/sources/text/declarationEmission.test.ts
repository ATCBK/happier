import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('emits real locale declarations while retaining exact keys and interpolation parameters', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const uiDir = join(repoRoot, 'apps/ui');
    const fixture = mkdtempSync(join(tmpdir(), 'happier-translation-types-'));
    const locales = ['en', 'ca', 'de', 'es', 'fr', 'it', 'ja', 'pl', 'pt', 'ru', 'zh-Hans', 'zh-Hant'];
    const consumerPath = join(fixture, 'consumer.ts');
    const consumer = `import { en } from ${JSON.stringify(join(uiDir, 'sources/text/translations/en'))};
import { ca } from ${JSON.stringify(join(uiDir, 'sources/text/translations/ca'))};
import { zhHans } from ${JSON.stringify(join(uiDir, 'sources/text/translations/zh-Hans'))};
import type { TranslationStructure } from ${JSON.stringify(join(uiDir, 'sources/text/_types'))};
export const title: string = en.sessionBoard.views.reconciled({ title: 'Board' });
export const key: keyof typeof en.sessionBoard.views = 'reconciled';
export const installation: string = en.identityAdministration.githubRemoveInstallationFor({ name: 'installation' });
export const identityKey: keyof typeof en.identityAdministration = 'githubRemoveInstallationFor';
export const localizedInstallation: string = ca.identityAdministration.githubRemoveInstallationFor({ name: 'installation' });
export const localizedIdentityKey: keyof typeof ca.identityAdministration = 'githubRemoveInstallationFor';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export const sharedEnglishStructure: Equal<typeof en, TranslationStructure> = true;
export const sharedLocalizedStructure: Equal<typeof ca, TranslationStructure> = true;
export const preservesLocalizedFunctionReturn: Equal<ReturnType<typeof zhHans.newSession.worktree.statusPill.changesSuffix>, string> = true;
`;
    try {
        const relativeFixture = relative(repoRoot, fixture);
        expect(relativeFixture === '..' || relativeFixture.startsWith(`..${sep}`) || isAbsolute(relativeFixture),
            'declaration fixtures must remain outside synchronized source').toBe(true);
        const config = {
            extends: join(uiDir, 'tsconfig.json'),
            compilerOptions: {
                noEmit: false,
                declaration: true,
                emitDeclarationOnly: true,
                incremental: false,
                rootDir: repoRoot,
                outDir: join(fixture, 'declarations'),
            },
            files: locales.map((locale) => join(uiDir, `sources/text/translations/${locale}.ts`)),
            include: [],
            exclude: [],
        };
        writeFileSync(join(fixture, 'tsconfig.json'), JSON.stringify(config));
        const run = () => spawnSync(process.execPath, [
            join(repoRoot, 'scripts/workspaces/runTypeScriptCli.mjs'),
            '--project', join(fixture, 'tsconfig.json'), '--pretty', 'false',
        ], { cwd: repoRoot, encoding: 'utf8' });
        writeFileSync(consumerPath, consumer);
        const emitted = run();
        expect(emitted.status, emitted.stdout + emitted.stderr).toBe(0);
        const declaration = readFileSync(join(fixture, 'declarations/apps/ui/sources/text/translations/en.d.ts'), 'utf8');
        expect(declaration.length).toBeGreaterThan(0);

        const declarationConsumer = ['translations/en', 'translations/ca', 'translations/zh-Hans', '_types'].reduce((text, module) => text.replace(
            JSON.stringify(join(uiDir, 'sources/text', module)),
            JSON.stringify(join(fixture, 'declarations/apps/ui/sources/text', module)),
        ), consumer);
        // Only authored locales emit under the repository root. The external
        // consumer checks those declarations without emitting or widening the
        // declaration producer's root to include the private scratch directory.
        const { rootDir: _rootDir, ...consumerCompilerOptions } = config.compilerOptions;
        writeFileSync(join(fixture, 'tsconfig.json'), JSON.stringify({ ...config,
            compilerOptions: { ...consumerCompilerOptions, noEmit: true, declaration: false, emitDeclarationOnly: false },
            files: [consumerPath],
        }));
        writeFileSync(consumerPath, declarationConsumer + `
en.sessionBoard.views.reconciled({ title: 42 });
export const invalid: keyof typeof en.sessionBoard.views = 'not-a-key';
en.identityAdministration.githubRemoveInstallationFor({ name: 42 });
export const invalidIdentity: keyof typeof en.identityAdministration = 'not-a-key';
ca.identityAdministration.githubRemoveInstallationFor({ name: 42 });
export const invalidLocalizedIdentity: keyof typeof ca.identityAdministration = 'not-a-key';
ca.common.cancel = 'changed';
const { common, ...missingNamespace } = ca;
export const invalidStructure: TranslationStructure = missingNamespace;
`);
        const rejected = run();
        expect(rejected.status).not.toBe(0);
        expect((rejected.stdout + rejected.stderr).match(/consumer\.ts.*TS2322/gu)).toHaveLength(6);
        expect((rejected.stdout + rejected.stderr).match(/consumer\.ts.*TS2540/gu)).toHaveLength(1);
        expect((rejected.stdout + rejected.stderr).match(/consumer\.ts.*TS2741/gu)).toHaveLength(1);
        expect((rejected.stdout + rejected.stderr).match(/error TS\d+:/gu)).toHaveLength(8);
    } finally {
        rmSync(fixture, { recursive: true, force: true });
    }
});
