import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';

// Compiler-consuming suites use hstack-exec's existing compilation admission wrapper
// before Vitest starts; the 60 s behavioral budget must not include capacity-queue time.
it('emits real locale declarations while retaining exact keys and interpolation parameters', async () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const uiDir = join(repoRoot, 'apps/ui');
    const fixture = mkdtempSync(join(tmpdir(), 'happier-translation-types-'));
    const locales = ['en', 'ca', 'de', 'es', 'fr', 'it', 'ja', 'pl', 'pt', 'ru', 'zh-Hans', 'zh-Hant'];
    const consumerPath = join(fixture, 'consumer.ts');
    const children = new Set<ChildProcess>();
    let compilerOutput = '';
    onTestFinished(async () => {
        if (children.size) process.stderr.write(`Unfinished locale declaration compiler:\n${compilerOutput}\n`);
        await Promise.all([...children].map(child => new Promise<void>(done => {
            child.once('close', () => done());
            // The canonical runner forwards termination to its owned compiler group.
            child.kill('SIGTERM');
        })));
    });
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
            compilerOptions: {
                // This is a locale declaration program, not an app/Expo program.
                strict: true,
                skipLibCheck: true,
                types: [],
                lib: ['ES2022'],
                target: 'ES2022',
                module: 'ESNext',
                moduleResolution: 'Bundler',
                noEmit: false,
                declaration: true,
                emitDeclarationOnly: true,
                listEmittedFiles: true,
                incremental: false,
                rootDir: repoRoot,
                outDir: join(fixture, 'declarations'),
            },
            files: locales.map((locale) => join(uiDir, `sources/text/translations/${locale}.ts`)),
            include: [],
            exclude: [],
        };
        writeFileSync(join(fixture, 'tsconfig.json'), JSON.stringify(config));
        const run = () => new Promise<{ status: number | null; output: string }>((done, reject) => {
            compilerOutput = '';
            const child = spawn(process.execPath, [
                join(repoRoot, 'scripts/workspaces/runTypeScriptCli.mjs'),
                '--project', join(fixture, 'tsconfig.json'), '--pretty', 'false',
            ], { cwd: repoRoot, env: { ...process.env, HAPPIER_TYPESCRIPT_COMPILER: 'microsoft' }, stdio: ['ignore', 'pipe', 'pipe'] });
            children.add(child);
            child.stdout.on('data', chunk => { compilerOutput += String(chunk); });
            child.stderr.on('data', chunk => { compilerOutput += String(chunk); });
            child.once('error', reject);
            child.once('close', status => { children.delete(child); done({ status, output: compilerOutput }); });
        });
        writeFileSync(consumerPath, consumer);
        const emitted = await run();
        expect(emitted.status, emitted.output).toBe(0);
        const emittedFiles = [...emitted.output.matchAll(/^TSFILE: (.+)$/gmu)].map(match => match[1]!.trim());
        expect(emittedFiles.length).toBeGreaterThanOrEqual(locales.length);
        const textOutput = join(fixture, 'declarations/apps/ui/sources/text');
        for (const file of emittedFiles) {
            const path = relative(textOutput, file);
            expect(path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path), file).toBe(false);
        }
        for (const locale of locales) {
            const declaration = readFileSync(join(fixture, `declarations/apps/ui/sources/text/translations/${locale}.d.ts`), 'utf8');
            expect(declaration.length).toBeGreaterThan(0);
        }

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
        const rejected = await run();
        expect(rejected.status).not.toBe(0);
        expect(rejected.output.match(/consumer\.ts.*TS2322/gu), rejected.output).toHaveLength(6);
        expect(rejected.output.match(/consumer\.ts.*TS2540/gu), rejected.output).toHaveLength(1);
        expect(rejected.output.match(/consumer\.ts.*TS2741/gu), rejected.output).toHaveLength(1);
        expect(rejected.output.match(/error TS\d+:/gu), rejected.output).toHaveLength(8);
    } finally {
        rmSync(fixture, { recursive: true, force: true });
    }
});
