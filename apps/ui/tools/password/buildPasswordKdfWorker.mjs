import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildUiSourceAsset } from '../sourceAsset.mjs';

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Same source producer is used for development, web and Tauri's static assets. */
export async function buildPasswordKdfWorker({ uiDirectory = uiDir,
    outputFile = resolve(uiDirectory, 'public/happier-password-kdf-worker.js'), retainLastGreen = false } = {}) {
    const built = await buildUiSourceAsset({ outputs: [outputFile], retainLastGreen, build: async () => {
        const result = await build({
            entryPoints: [resolve(uiDirectory, 'sources/auth/password/passwordKdf.worker.ts')],
            // Source preparation can run before workspace dist exists.
            alias: {
                '@happier-dev/protocol/auth/accountPasswordCredential':
                    resolve(uiDirectory, '../../packages/protocol/src/auth/accountPasswordCredential.ts'),
            },
            bundle: true,
            platform: 'browser',
            format: 'iife',
            target: ['es2020'],
            minify: true,
            write: false,
        });
        const contents = result.outputFiles[0].text;
        const previous = await readFile(outputFile, 'utf8').catch((error) => {
            if (error?.code === 'ENOENT') return null;
            throw error;
        });
        if (previous !== contents) {
            await mkdir(dirname(outputFile), { recursive: true });
            await writeFile(outputFile, contents);
        }
        return { outputFile, bytes: result.outputFiles[0].contents.byteLength };
    } });
    return { outputFile, ...built };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await buildPasswordKdfWorker();
}
