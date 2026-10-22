import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cliCommonServerRuntime from '@happier-dev/cli-common/firstPartyRuntime/server';
import * as protocol from '@happier-dev/protocol';

import { FEATURE_ENV_KEYS } from '@/app/features/catalog/featureEnvSchema';
import { SERVER_CONFIG_REGISTRY } from '@/config/serverConfigRegistry';

import { checkServerConfigCoverage, formatServerConfigCoverageReport, listServerSourceFiles } from './serverConfigCoverage';

/**
 * `pnpm --dir apps/server run config:coverage` — prints every env read the server configuration
 * registry does not cover. CI enforces the same check through `serverConfigCoverage.spec.ts`.
 */
const sources = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sources');
const report = checkServerConfigCoverage({
    registry: SERVER_CONFIG_REGISTRY,
    indirection: { featureEnvKeys: FEATURE_ENV_KEYS, constants: { ...protocol, ...cliCommonServerRuntime } as Readonly<Record<string, unknown>> },
    files: listServerSourceFiles(sources),
});
const text = formatServerConfigCoverageReport(report);
if (text) {
    process.stdout.write(`${text}\n`);
    process.exitCode = 1;
} else {
    process.stdout.write(`Server configuration coverage: ${Object.keys(SERVER_CONFIG_REGISTRY).length} declared keys, no undeclared reads.\n`);
}
