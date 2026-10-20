/** @moduleRealm daemon */
/** @moduleRealm build */
import type { Plugin } from 'esbuild';
import { dirname } from 'node:path';

const namespace = 'happier-zod-mini-english';
const resolvingOriginal = 'happierZodMiniEnglishResolvingOriginal';

/**
 * Bundled plugin artifacts have their own Zod core. Configure only artifacts
 * that import Mini, using the exact package installation their entry resolved.
 */
export function createZodMiniEnglishLocaleCompilerPlugin(): Plugin {
    const resolvedModules = new Map<string, Readonly<{ mini: string; english: string }>>();
    return {
        name: 'happier-zod-mini-english',
        setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^zod\/mini$/ }, async (args) => {
                if (args.pluginData?.[resolvingOriginal] === true) return;
                const options = {
                    kind: args.kind,
                    importer: args.importer,
                    resolveDir: args.resolveDir,
                    pluginData: { ...args.pluginData, [resolvingOriginal]: true },
                } as const;
                const mini = await pluginBuild.resolve(args.path, options);
                if (mini.errors.length > 0) return { errors: mini.errors };
                const english = await pluginBuild.resolve('zod/v4/locales/en.js', {
                    ...options,
                    resolveDir: dirname(mini.path),
                });
                if (english.errors.length > 0) return { errors: english.errors };
                if (!mini.path || mini.external || !english.path || english.external) {
                    return { errors: [{ text: 'Bundled Zod Mini and English locale must resolve to files' }] };
                }
                resolvedModules.set(mini.path, { mini: mini.path, english: english.path });
                return { path: mini.path, namespace };
            });
            pluginBuild.onLoad({ filter: /.*/, namespace }, (args) => {
                const resolved = resolvedModules.get(args.path);
                if (!resolved) throw new Error('Resolved Zod Mini locale module is missing');
                return {
                    contents: [
                        `import { config } from ${JSON.stringify(resolved.mini)};`,
                        `import en from ${JSON.stringify(resolved.english)};`,
                        'config(en());',
                        `export * from ${JSON.stringify(resolved.mini)};`,
                    ].join('\n'),
                    loader: 'js',
                    resolveDir: dirname(resolved.mini),
                };
            });
        },
    };
}
