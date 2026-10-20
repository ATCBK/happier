import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildUiSourceWorker } from '../sourceAsset.mjs';

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function buildCryptoWorker({ uiDirectory = uiDir,
    outputFile = resolve(uiDirectory, 'public/happier-crypto-worker.js'), retainLastGreen = false } = {}) {
    return buildUiSourceWorker({
        entryPoint: resolve(uiDirectory, 'sources/sync/encryption/nativeCryptoWorker/webCryptoWorker.ts'),
        outputFile, retainLastGreen,
        alias: { '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1':
            resolve(uiDirectory, '../../packages/protocol/src/crypto/encryptedDataKeyEnvelopeV1.ts') },
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await buildCryptoWorker();
}
