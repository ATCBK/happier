import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromTest = createRequire(import.meta.url);

type PackageExportTarget = Readonly<{
    types?: string;
    default?: string;
}>;

function readProtocolExports(): Record<string, PackageExportTarget> {
    const raw = readFileSync(resolve(packageDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { exports?: Record<string, PackageExportTarget> };
    return parsed.exports ?? {};
}

describe('Protocol package runtime contracts', () => {
    it('keeps external Action response limits under one browser-safe owner', async () => {
        const [api, limits] = await Promise.all([
            import('@happier-dev/protocol/actions/externalActionApi'),
            import('@happier-dev/protocol/actions/externalActionLimits'),
        ]);
        expect(api.EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES)
            .toBe(limits.EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
        expect(api.measureExternalActionResultResponseEnvelopeUtf8BytesV1)
            .toBe(limits.measureExternalActionResultResponseEnvelopeUtf8BytesV1);
        expect(api.isExternalActionResultWithinResponseEnvelopeLimitV1)
            .toBe(limits.isExternalActionResultWithinResponseEnvelopeLimitV1);
    });

    it('resolves every published default subpath to its emitted runtime entrypoint', () => {
        const protocolExports = readProtocolExports();
        expect(Object.keys(protocolExports).length).toBeGreaterThan(0);
        for (const [specifier, target] of Object.entries(protocolExports)) {
            expect(target.default, specifier).toMatch(/^\.\/dist\/.*\.js$/);
            expect(target.types, specifier).toMatch(/^\.\/dist\/.*\.d\.ts$/);
            const packageSpecifier = specifier === '.'
                ? '@happier-dev/protocol'
                : `@happier-dev/protocol${specifier.slice(1)}`;
            expect(requireFromTest.resolve(packageSpecifier), packageSpecifier)
                .toBe(resolve(packageDir, target.default ?? ''));
        }
    });

    it('emits current Follow, permission, and Board helpers through their declared public entrypoints', async () => {
        // Vitest aliases workspace imports to source. Load the export-map targets
        // directly to exercise what built-package consumers actually receive.
        const [protocol, board] = await Promise.all([
            import(pathToFileURL(requireFromTest.resolve('@happier-dev/protocol')).href),
            import(pathToFileURL(requireFromTest.resolve('@happier-dev/protocol/sessions/board')).href),
        ]);
        expect(protocol.buildSessionFollowSourceKeyPrepareRequestV1).toBeTypeOf('function');
        expect(protocol.pluginPermissionSubjectsEqualV1).toBeTypeOf('function');
        expect(board.bindSessionBoardMutationRequestV1).toBeTypeOf('function');
        expect(board.createSessionBoardFailureV1).toBeTypeOf('function');
    }, 60_000);
});
