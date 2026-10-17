import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildUiSourceWorker } from '../sourceAsset.mjs';

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Same source producer is used for development, web and Tauri's static assets. */
export async function buildPasswordKdfWorker({ uiDirectory = uiDir,
    outputFile = resolve(uiDirectory, 'public/happier-password-kdf-worker.js'), retainLastGreen = false } = {}) {
    return buildUiSourceWorker({
        entryPoint: resolve(uiDirectory, 'sources/auth/password/passwordKdf.worker.ts'),
        outputFile, retainLastGreen,
        // Source preparation can run before workspace dist exists.
        alias: { '@happier-dev/protocol/auth/accountPasswordCredential':
            resolve(uiDirectory, '../../packages/protocol/src/auth/accountPasswordCredential.ts') },
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await buildPasswordKdfWorker();
}
