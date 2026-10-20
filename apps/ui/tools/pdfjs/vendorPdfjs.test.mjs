import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { vendorPdfjs } from './vendorPdfjs.mjs';

test('vendoring uses the installed version and contracts old assets while retaining license', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'happier-pdf-vendor-'));
    try {
        const packageDir = path.join(root, 'package');
        for (const file of ['legacy/build/pdf.worker.min.mjs', 'cmaps/test.bcmap', 'standard_fonts/font.pfb', 'wasm/openjpeg.wasm', 'iccs/sRGB.icc', 'LICENSE']) {
            await fs.mkdir(path.dirname(path.join(packageDir, file)), { recursive: true });
            await fs.writeFile(path.join(packageDir, file), file);
        }
        await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ version: '6.4.299' }));
        const outputRoot = path.join(root, 'public', 'pdfjs');
        await fs.mkdir(path.join(outputRoot, 'old-version'), { recursive: true });
        await fs.writeFile(path.join(outputRoot, 'old-version', 'stale'), 'old');
        const result = await vendorPdfjs({ expoAppDir: root, packageDir });
        assert.equal(result.version, '6.4.299');
        assert.equal(await fs.readFile(path.join(outputRoot, result.version, 'pdf.worker.min.js'), 'utf8'), 'legacy/build/pdf.worker.min.mjs');
        for (const file of ['cmaps/test.bcmap', 'standard_fonts/font.pfb', 'wasm/openjpeg.wasm', 'iccs/sRGB.icc', 'LICENSE']) {
            assert.equal(await fs.readFile(path.join(outputRoot, result.version, file), 'utf8'), file);
        }
        assert.deepEqual(await fs.readdir(outputRoot), ['6.4.299']);
        await vendorPdfjs({ expoAppDir: root, packageDir });
        assert.equal(await fs.readFile(path.join(outputRoot, result.version, 'LICENSE'), 'utf8'), 'LICENSE');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
