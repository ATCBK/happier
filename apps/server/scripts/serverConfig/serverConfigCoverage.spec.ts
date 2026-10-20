import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cliCommonServerRuntime from '@happier-dev/cli-common/firstPartyRuntime/server';
import * as protocol from '@happier-dev/protocol';
import { composeServerConfigRegistry, defineServerConfigRegistry } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { FEATURE_ENV_KEYS } from '@/app/features/catalog/featureEnvSchema';
import { SERVER_CONFIG_REGISTRY } from '@/config/serverConfigRegistry';

import { checkServerConfigCoverage, formatServerConfigCoverageReport, listServerSourceFiles } from './serverConfigCoverage';

const SERVER_SOURCES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sources');
const INDIRECTION = { featureEnvKeys: FEATURE_ENV_KEYS, constants: { ...protocol, ...cliCommonServerRuntime } as Readonly<Record<string, unknown>> };

const FIXTURE_REGISTRY = composeServerConfigRegistry(
    defineServerConfigRegistry({
        HAPPIER_DECLARED: { type: 'string', sensitivity: 'plain', apply: 'restart', editable: 'home', section: 'server', description: 'Declared.' },
    }),
);

describe('checkServerConfigCoverage', () => {
    it('reports every undeclared env read, however the key reaches the env access, and ignores comments', () => {
        const report = checkServerConfigCoverage({
            registry: FIXTURE_REGISTRY,
            indirection: { featureEnvKeys: { teamsEnabled: 'HAPPIER_FEATURE_TEAMS__ENABLED' }, constants: {} },
            files: [
                {
                    file: 'reader.ts',
                    source: [
                        '// process.env.HAPPIER_ONLY_IN_A_COMMENT is not a read',
                        'const declared = process.env.HAPPIER_DECLARED;',
                        "const host = requiredEnv(env, 'S3_UNDECLARED');",
                        'const teams = env[FEATURE_ENV_KEYS.teamsEnabled];',
                        "const KEY = 'HAPPIER_LOCAL_CONSTANT';",
                        'const local = safeEnv[KEY];',
                        'const url = "https://example.test"; const port = process.env.PORT;',
                    ].join('\n'),
                },
            ],
        });
        expect(report.undeclared.map((read) => [read.name, read.line])).toEqual([
            ['PORT', 7],
            ['S3_UNDECLARED', 3],
            ['HAPPIER_FEATURE_TEAMS__ENABLED', 4],
            ['HAPPIER_LOCAL_CONSTANT', 6],
            ['HAPPIER_LOCAL_CONSTANT', 5],
        ]);
        expect(report.unresolved).toEqual([]);
    });

    it('reports an env access whose key cannot be resolved', () => {
        const report = checkServerConfigCoverage({
            registry: FIXTURE_REGISTRY,
            indirection: { featureEnvKeys: {}, constants: { IMPORTED_DECLARED_KEY: 'HAPPIER_DECLARED' } },
            files: [{ file: 'indirect.ts', source: 'const a = env[IMPORTED_DECLARED_KEY];\nconst b = env[IMPORTED_KEY_CONSTANT];' }],
        });
        expect(report.undeclared).toEqual([]);
        expect(report.unresolved.map((item) => [item.expression, item.line])).toEqual([['env[IMPORTED_KEY_CONSTANT]', 2]]);
    });

    it('ignores embedded JavaScript data while checking executable reads in the same generated file', () => {
        const report = checkServerConfigCoverage({
            registry: FIXTURE_REGISTRY,
            indirection: { featureEnvKeys: {}, constants: {} },
            files: [{
                file: 'publicShareViewerBundle.generated.ts',
                source: [
                    `export const bundle = ${JSON.stringify('process.env.NODE_DEBUG; env[EMBEDDED_KEY]; "HAPPIER_EMBEDDED_KEY";')};`,
                    "const example = 'process.env.HAPPIER_DATA_ONLY';",
                    'const template = `process.env.NODE_DEBUG ${process.env.TEMPLATE_READ}`;',
                    'const actual = process.env.ACTUAL_READ;',
                    'const indexed = env["INDEXED_READ"];',
                    'const helper = readTrimmed(env, "HELPER_READ");',
                    'const key = "HAPPIER_LITERAL_KEY";',
                    'const unresolved = env[UNKNOWN_KEY];',
                ].join('\n'),
            }],
        });
        expect(report.undeclared.map((read) => [read.name, read.line])).toEqual([
            ['TEMPLATE_READ', 3],
            ['ACTUAL_READ', 4],
            ['INDEXED_READ', 5],
            ['HELPER_READ', 6],
            ['HAPPIER_LITERAL_KEY', 7],
        ]);
        expect(report.unresolved.map((item) => [item.expression, item.line])).toEqual([['env[UNKNOWN_KEY]', 8]]);
    });

    it('keeps executable env reads separated by comments', () => {
        const report = checkServerConfigCoverage({
            registry: FIXTURE_REGISTRY,
            indirection: { featureEnvKeys: {}, constants: {} },
            files: [{ file: 'comments.ts', source: [
                'const actual = process.env /* note */ .ACTUAL_READ;',
                'const indexed = env[ /* note */ "INDEXED_READ"];',
                'const helper = readTrimmed(env, /* note */ "HELPER_READ");',
            ].join('\n') }],
        });
        expect(report.undeclared.map((read) => [read.name, read.line])).toEqual([
            ['ACTUAL_READ', 1],
            ['INDEXED_READ', 2],
            ['HELPER_READ', 3],
        ]);
        expect(report.unresolved).toEqual([]);
    });

    it('finds every env key server source reads in the registry', () => {
        const report = checkServerConfigCoverage({
            registry: SERVER_CONFIG_REGISTRY,
            indirection: INDIRECTION,
            files: listServerSourceFiles(SERVER_SOURCES),
        });
        expect(formatServerConfigCoverageReport(report)).toBe('');
    }, 180_000); // scans every server source file; the default 20 s is too short on a loaded host
});
