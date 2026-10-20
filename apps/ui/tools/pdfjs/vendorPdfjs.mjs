import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function vendorPdfjs({ expoAppDir, packageDir }) {
    const require = createRequire(path.join(expoAppDir, 'package.json'));
    const source = packageDir ?? path.dirname(require.resolve('pdfjs-dist/package.json'));
    const { version } = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid pdfjs-dist version');
    const outputRoot = path.join(expoAppDir, 'public', 'pdfjs');
    const destination = path.join(outputRoot, version);
    await fs.mkdir(destination, { recursive: true });
    await fs.copyFile(path.join(source, 'legacy', 'build', 'pdf.worker.min.mjs'), path.join(destination, 'pdf.worker.min.js'));
    for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
        await fs.cp(path.join(source, directory), path.join(destination, directory), { recursive: true, force: true });
    }
    await fs.copyFile(path.join(source, 'LICENSE'), path.join(destination, 'LICENSE'));
    // The version is in every URL because the static server caches scripts immutably.
    // Only this producer's exact public/pdfjs output directory is contracted.
    for (const entry of await fs.readdir(outputRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== version) await fs.rm(path.join(outputRoot, entry.name), { recursive: true, force: true });
    }
    return { version, destination };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const expoAppDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const result = await vendorPdfjs({ expoAppDir });
    console.log(`[pdfjs] assets ready: ${path.relative(expoAppDir, result.destination)}`);
}
