import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { vi } from 'vitest';
import type { ProviderContributionV1 } from '@happier-dev/protocol';
import type { ProviderCatalogProbeModelV1 } from '@happier-dev/protocol/providers/catalog/merge';

import { createConnectedAccountPurposeBindingOwner, type ConnectedAccountPurposeBindingOwnerDependencies } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import * as persistence from '@/persistence';
import { configuration } from '@/configuration';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { createLocalPathPluginDistributionIdentity, createPluginTrustRecord } from '@/plugins/store/install/trustIdentity';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';

import { createPluginReloadController, type PluginReloadController } from './reload/controller';
import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

/** Real installed Provider, purpose authority, registry and OS gateway fixture. */
export function createSharedGatewayRegistryTestkit(input: Readonly<{
    directory: string;
    happyHomeDir?: string;
    controller?: PluginReloadController;
    pluginId?: string;
    peerId?: string;
    resolveAccountTarget?: ConnectedAccountPurposeBindingOwnerDependencies['resolveTarget'];
    credential?: ProviderContributionV1['credential'];
    compatibilityOverrides?: ProviderContributionV1['compatibilityOverrides'];
    catalog?: ProviderContributionV1['catalog'];
    catalogModels?: readonly ProviderCatalogProbeModelV1[];
    holdResponseForInput?: string;
}>) {
    const { directory } = input;
    const happyHomeDir = input.happyHomeDir ?? join(directory, 'home');
    const pluginId = input.pluginId ?? 'acme.shared-registry';
    const peerId = input.peerId ?? 'acme.unrelated-registry';
    const controller = input.controller ?? createPluginReloadController();
    const identity = { pluginId, localId: 'gateway' };
    const purposeBindings = { v: 1 as const, bindings: [{ purpose: { consumer: identity, purpose: 'upstream' },
        target: { kind: 'account' as const, account: { service: { pluginId, localId: 'accounts' }, accountId: 'upstream-account' } } }] };
    const readCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({
        token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.fixture`, encryption: null,
    });
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected account transport'); };
    // Only persistent account selection is a boundary. Purpose admission,
    // subject custody, capability files and plugin loading execute for real.
    const purposeBindingOwner = createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected,
            subscribe: () => ({ dispose() {} }) },
        selectTarget: unexpected, resolveTarget: input.resolveAccountTarget ?? unexpected, materializeAccount: unexpected,
        projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
    });
    const operationAuthority = createManagedProviderOperationAuthority({
        materializationBaseDir: join(directory, 'request-auth'), purposeBindingOwner,
        requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
        createRedactionLease: () => ({ add() {}, close() {} }),
    });
    const install = async (id: string, version: string, gateway: boolean) => {
        const root = join(directory, id);
        await mkdir(join(root, '.happier-plugin'), { recursive: true });
        const manifestPath = join(root, '.happier-plugin', 'plugin.json');
        await writeFile(manifestPath, JSON.stringify({
            schemaVersion: 2, id, version, displayName: id, engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            contributes: gateway ? {
                connectedAccountDescriptors: [{ id: 'accounts', title: 'Fixture account',
                    authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                        fields: [{ id: 'token', title: 'Token', schema: { type: 'string', minLength: 1 }, secret: true }] }] } }],
                providers: [{ v: 1, id: 'gateway', name: 'Gateway', kind: 'aggregator',
                    ...(input.credential === undefined ? {} : { credential: input.credential }),
                    ...(input.compatibilityOverrides === undefined ? {} : { compatibilityOverrides: input.compatibilityOverrides }),
                    endpointTemplates: [{ id: 'api', protocol: 'openai-responses', baseUrl: 'https://example.test/v1',
                        capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unknown', reasoningControls: 'supported' } }],
                    catalog: input.catalog ?? { source: 'static', manualModelPolicy: 'allowed', staticModels: [{ id: 'example', name: 'Example' }] },
                    managedRuntime: { kind: 'managed', sharing: 'connectionMachine', endpointTemplateIds: ['api'],
                        connectedAccounts: [{ purpose: 'upstream', title: { key: 'upstream.title', fallback: 'Upstream account' }, service: 'accounts', required: false, materializationKinds: ['httpHeaders'] }],
                        requestAuthUses: [{ purpose: 'upstream', materialization: { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] } }] } }],
            } : {},
        }));
        if (gateway) {
            await mkdir(join(root, 'tools'), { recursive: true });
            const executablePath = join(root, 'tools', process.platform === 'win32' ? 'gateway.exe' : 'gateway');
            // Installed test executable; not a frozen feature/release build.
            await copyFile(process.execPath, executablePath);
            await chmod(executablePath, 0o755);
        }
        const catalogModels = input.catalogModels ?? [{ id: 'example' }];
        const script = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(join(directory, 'gateway-started'))},String(process.pid));fs.appendFileSync(${JSON.stringify(join(directory, 'gateway-starts'))},String(process.pid)+"\\n");require("node:http").createServer((req,res)=>{if(req.method==="POST"&&req.url==="/v1/responses"){let body="";req.on("data",chunk=>{body+=chunk});req.on("end",()=>{let input;try{input=JSON.parse(body).input}catch{}fs.appendFileSync(${JSON.stringify(join(directory, 'gateway-inputs'))},input+"\\n");if(${input.holdResponseForInput === undefined ? 'true' : `input!==${JSON.stringify(input.holdResponseForInput)}`})res.end("ok")});return;}if(req.url==="/v1/models"){res.setHeader("content-type","application/json");res.end(JSON.stringify({object:"list",data:${JSON.stringify(catalogModels.map(model => ({ ...model, object: 'model',
          ...(model.connectedAccountPurposes ? { happier_connected_account_purposes: model.connectedAccountPurposes,
            connectedAccountPurposes: undefined } : {}),
        })))} }));return;}res.end(req.url==="/pid"?String(process.pid):"ok")}).listen(Number(process.env.PORT),"127.0.0.1")`;
        await writeFile(join(root, 'daemon.mjs'), gateway ? `export function activate(api) {
            api.connectedAccounts.register('accounts', {
                authentication: { modes: { manual: { kind: 'manual', async complete() {
                    return { status: 'connected', accountId: 'upstream-account', displayName: 'Fixture', scopes: [] };
                } } } },
                async refresh() { return { status: 'unavailable' }; },
                async revoke() { return { status: 'remoteUnsupported' }; },
                async status() { return { status: 'connected', displayName: 'Fixture' }; },
                async materialize() { return { kind: 'httpHeaders', headers: {} }; }
            });
            api.providers.register('gateway', { async start(request, context) {
                const service = await context.managedServices.supervise({
                    id: 'shared-gateway', mode: { kind: 'spawn', launch: {
                        executable: { kind: 'packaged-runtime-binary', directorySegments: ['tools'], executableBaseName: 'gateway' },
                        args: ['-e', ${JSON.stringify(script)}]
                    }, endpoint: { kind: 'assignAndInject', port: { kind: 'allocated' }, inject: { portEnvironmentKey: 'PORT' } } },
                    healthCheck: { kind: 'http', target: { path: '/healthz' } },
                    requestAuth: { kind: 'connectedAccountConsumerAccessPath', injectEnvironmentKey: 'CONSUMER_ACCESS_PATH' },
                    clientAccess: { kind: 'hostBearer', injectEnvironmentKey: 'MANAGEMENT_TOKEN', headerName: 'authorization', scheme: 'Bearer' }
                });
                await service.waitUntilHealthy();
                return { service, endpoints: [{ endpointTemplateId: 'api', endpoint: { kind: 'servicePath', path: '/v1' } }] };
            } });
        }` : 'export function activate() {}');
        const distribution = await createLocalPathPluginDistributionIdentity(root);
        await writeCommittedLocalPathPluginFixture({ happyHomeDir, pluginId: id, sourceRootPath: root, preserveExistingPlugins: true,
            plugin: { source: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: root, manifestPath },
                compatibility: { status: 'unknown', diagnostics: [] },
                install: { mode: 'link', manifestVersion: version, installedPath: null,
                    trust: createPluginTrustRecord({ pluginId: id, distribution, approvedAtMs: Date.now() }) }, state: { enabled: true } } });
    };
    const createRegistry = async (changed: ReadonlySet<string>) => {
        const contributes = createMergedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external', existingAgentIds: new Set(),
        }), {});
        const generationAuthority = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({ happyHomeDir }), {});
        if (!generationAuthority) throw new Error('Expected installed generation authority');
        const serving = controller.retainServingSlots?.(changed);
        return await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes, generationAuthority,
            ...(serving ? { servingPluginOccurrences: serving.occurrencesByPluginId, retainedActivationRegistryLeases: serving.leases } : {}),
            managedProviderOperationAuthority: operationAuthority, resolveCurrentMachineId: () => 'machine',
            readDaemonRequesterWorkAttribution: () => {
                const installation = readInstallationIdentityIfExistsSync(join(happyHomeDir, 'installation-identity.json'));
                return installation ? { serverId: configuration.activeServerId, accountId: 'account', machineId: 'machine',
                    installationId: installation.installationId } : null;
            },
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'home', machineId: 'machine' }),
        });
    };
    return { directory, happyHomeDir, pluginId, peerId, controller, identity, purposeBindings, purposeBindingOwner, operationAuthority,
        install, createRegistry, disposeCredentialBoundary: () => readCredentials.mockRestore() };
}
