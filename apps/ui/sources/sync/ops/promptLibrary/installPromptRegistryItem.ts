import { installPromptRegistryItemInLibrary, type PromptLibraryArtifactStore, type LegacySkillRegistryInstallResultV1 } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { encodeBase64 } from '@/encryption/base64';
import { randomUUID } from '@/platform/randomUUID';
import { createUiRegistryHostV1 } from '@/registries/registryHostDeps';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { defaultPromptAssetTargetInput } from '@/components/settings/prompts/assets/promptAssetExportDefaults';
import { withUiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';
import { writePromptAssetWithRecovery } from './exportPromptLibraryArtifact';

export type PromptRegistryInstallResult = LegacySkillRegistryInstallResultV1;
type RegistryInstallOwner = Parameters<typeof installPromptRegistryItemInLibrary>[0];
export type PromptRegistryInstallArgs = RegistryInstallOwner['request'] & Pick<RegistryInstallOwner, 'machineTarget' | 'libraryServerIdentityId' | 'signal'>;

/** Retained external-target semantics delegate to the one protocol owner and the new pinned skill install. */
export async function installPromptRegistryItem(args: PromptRegistryInstallArgs, store?: PromptLibraryArtifactStore,
    capturedAccount?: LazyActionAccountContext, context?: ActionExecutorContext,
    installLibrary?: RegistryInstallOwner['installLibrary']): Promise<PromptRegistryInstallResult> {
    const run = async (current: PromptLibraryArtifactStore, account: LazyActionAccountContext) => {
        if (!current.organization) throw new Error('registry_sources_unavailable');
        const invocation = context ?? { surface: 'ui' as const, authority: 'present_user' as const, serverId: account.serverId, signal: args.signal };
        const registry = await createUiRegistryHostV1(account, current.organization, invocation);
        let title = '';
        return installPromptRegistryItemInLibrary({
            machineTarget: args.machineTarget, libraryServerIdentityId: args.libraryServerIdentityId, signal: args.signal,
            randomId: randomUUID, request: { machineId: args.machineId, serverId: args.serverId, sourceId: args.sourceId,
                itemId: args.itemId, promptExternalLinks: args.promptExternalLinks, previewOnly: args.previewOnly,
                ...(args.installTarget ? { installTarget: args.installTarget } : {}) },
            fetchItem: async ({ sourceId, itemId }) => {
                const item = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read',
                    { kind: 'skill', sourceId, itemId })).item;
                if (!item.summary.version) throw new Error('registry_version_unavailable');
                title = item.summary.title;
                const files = (await registry.filesForPointer({ sourceId: item.summary.sourceId, itemId: item.summary.itemId, version: item.summary.version }))
                    .map(file => { let contentKind: 'utf8' | 'binary' = 'utf8';
                        try { new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); } catch { contentKind = 'binary'; }
                        return { path: file.path, unixMode: file.unixMode, contentBase64: encodeBase64(file.bytes, 'base64'), contentKind }; });
                return { item, files };
            },
            install: ({ machineId, serverId, request }) => writePromptAssetWithRecovery(machineId, { ...request,
                targetName: request.targetName.trim() || defaultPromptAssetTargetInput({ libraryKind: 'bundle', title }) },
                { ...(serverId ? { serverId } : {}), signal: args.signal }),
            installLibrary: installLibrary ?? (async pointer => {
                const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
                const result = await executeDefaultActionInCapturedAccount(account, 'skills.install', { source: { kind: 'registry', ...pointer } },
                    { ...invocation, serverId: account.serverId, expectedAccountId: account.accountId, signal: args.signal });
                return result.ok ? result.result : result;
            }),
        });
    };
    return store && capturedAccount ? run(store, capturedAccount) : withUiPromptLibraryArtifactStore(run, { signal: args.signal });
}
