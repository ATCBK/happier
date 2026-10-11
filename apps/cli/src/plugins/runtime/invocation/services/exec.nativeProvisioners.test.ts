import { describe, expect, it, vi } from 'vitest';
import { LUME_PLUGIN } from '@happier-dev/plugins-machine-lume/manifest';
import { CUA_PLUGIN } from '@happier-dev/plugins-machine-cua/manifest';
import { DOCKER_SANDBOXES_PLUGIN } from '@happier-dev/plugins-machine-docker-sandboxes/manifest';

import { createProductionPluginInvocationServiceOwners } from './production';

describe('native provisioner production process composition', () => {
    it.each([LUME_PLUGIN.manifest, CUA_PLUGIN.manifest, DOCKER_SANDBOXES_PLUGIN.manifest])(
        'preserves the selected native environment without disclosing unrelated ambient values for $id',
        async (manifest) => {
            vi.stubEnv('UNRELATED_SECRET', 'ambient-secret');
            vi.stubEnv('NATIVE_CONFIGURATION', 'ambient-configuration');
            const owners = createProductionPluginInvocationServiceOwners({
                loggerSink: { write() {} },
                exec: {
                    // Replace only the native executable, keeping host composition
                    // and process supervision real for each public manifest.
                    resolveExecutable: async () => ({ command: process.execPath }),
                    resolvePath: async () => process.cwd(),
                },
            });
            try {
                const requests = manifest.hostAccess.required.map(request => ({ request, required: true }));
                const processRequest = manifest.hostAccess.required.find(request => request.capability === 'process');
                if (!processRequest || processRequest.capability !== 'process') throw new Error('Native process declaration is missing');
                const executable = processRequest.scope.executables[0];
                if (!executable) throw new Error('Native executable declaration is missing');
                const seed = {
                    plugin: { id: manifest.id, version: manifest.version },
                    contribution: { id: 'check', qualifiedId: `${manifest.id}/actions/check` },
                    occurrenceId: 'native-process-test', correlationId: 'native-process-test', surface: 'cli' as const,
                    signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                };
                const binding = owners.resolveInvocationHostPolicy({ pluginId: manifest.id,
                    occurrenceId: seed.occurrenceId, qualifiedId: seed.contribution.qualifiedId,
                }, { hostAccessRequests: requests, surface: seed.surface, signal: seed.signal }).serviceBinding;
                const services = owners.createServices(seed, binding);
                const result = await services.exec.run({ executable,
                    args: ['-e', 'process.stdout.write(JSON.stringify({selected:process.env.NATIVE_CONFIGURATION, unrelated:process.env.UNRELATED_SECRET ?? null}))'],
                    env: { NATIVE_CONFIGURATION: 'selected-configuration' },
                });
                expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
                expect(JSON.parse(Buffer.from(result.stdout).toString())).toEqual({ selected: 'selected-configuration', unrelated: null });
            } finally {
                await owners.dispose();
                vi.unstubAllEnvs();
            }
        },
    );
});
