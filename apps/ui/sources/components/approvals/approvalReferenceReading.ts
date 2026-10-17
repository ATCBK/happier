import { t } from '@/text';
import { storage, useArtifact, useProjectAccountRows, useServerScopedMachine } from '@/sync/domains/state/storage';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useProviderCatalogForServer } from '@/sync/store/useProviderCatalog';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { presentProviderConnectionIdentity } from '@/providers/connection/presentation';
import { areProviderContributionKeysEqualV1 } from '@happier-dev/protocol/providers/contribution-identity';
import { builtInSettingUiDeclaration } from '@/components/settings/catalog/settingDeclarations';
import { useMcpServerCatalogForServer } from '@/components/settings/mcpServers/useMcpServersSettings';
import { mcpServerDisplayName } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useAgentCatalogIdentities } from '@/agents/registry/useSessionAgentCatalogIdentity';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '@happier-dev/protocol/registries';
import type { ApprovalActionReference } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { describeUnnamedApprovalSession, resolveApprovalHomeName, resolveApprovalHomeSentenceName } from './approvalRequesterLabels';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readMcpServerCatalogInContext } from '@/sync/api/account/apiMcpServerCatalog';
import { projectMcpServerCatalogSnapshot } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { getPromptLibraryCatalogValue } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { getProviderCatalogSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { readCurrentProjectAccountRows } from '@/sync/domains/workspaces/projectAccountRows';
import { useApprovalSessionReading } from './useApprovalSessionReading';
type ApprovalReference = ApprovalActionReference;

export type ApprovalReferenceReading = Readonly<{ text: string; named: boolean; resolving?: boolean }>;

/** Both cached UI rows and authorized exact reads use the same content-readable name rule. */
function readApprovalArtifactReference(reference: ApprovalReference, artifact: DecryptedArtifact | null | undefined): ApprovalReferenceReading {
    const readable = artifact?.isDecrypted === true && (reference.kind === 'artifact'
        || reference.kind === 'skill' && artifact.header?.kind === 'prompt_bundle.v2'
            && artifact.header.bundleSchemaId === 'skills.skill_md_v1');
    const title = readable ? artifact.title?.trim() || artifact.header?.title?.trim() : null;
    return { text: title || reference.id, named: Boolean(title) };
}

/** An invocation has captured its Account; references are read there, never on the focused Home. */
export async function readApprovalReferenceForConfirmation(reference: ApprovalReference | undefined,
    account: LazyActionAccountContext, signal?: AbortSignal): Promise<ApprovalReferenceReading> {
    if (!reference) return { text: '', named: false };
    const scope = { serverId: account.serverId, accountId: account.accountId };
    const state = storage.getState();
    const sources: ApprovalReferenceSources = {
        serverId: reference.kind === 'session' ? reference.serverId ?? account.serverId : account.serverId,
        viewer: scope, ownHome: true, sessionReading: { name: null, machineId: '', status: 'unavailable' },
        declarations: readAccountProviderDeclarations(),
        machine: reference.kind === 'machine' ? resolveServerScopedMachine(state, account.serverId, reference.id) : null,
        registries: getPromptLibraryCatalogValue(scope, 'registry-sources'),
        projects: readCurrentProjectAccountRows(state),
        providerCatalog: getProviderCatalogSnapshot(scope),
    };
    if (reference.kind === 'artifact' || reference.kind === 'skill') {
        sources.artifact = await account.fetchArtifact(reference.id, { signal });
        account.assertCurrent();
    }
    if (reference.kind === 'mcpServer') {
        const snapshot = await readMcpServerCatalogInContext(account, signal);
        account.assertCurrent();
        sources.mcp = projectMcpServerCatalogSnapshot(snapshot);
    }
    return resolveApprovalReferenceReading(reference, reference.id, account.serverId, sources);
}

export function useApprovalReferenceReading(reference: ApprovalReference | undefined, literal: string, approvalServerId: string | null): ApprovalReferenceReading {
    const serverId = reference?.kind === 'session' ? reference.serverId ?? approvalServerId : approvalServerId;
    const sessionReading = useApprovalSessionReading(reference?.kind === 'session' ? serverId : null,
        reference?.kind === 'session' ? reference.id : '');
    const viewer = useAccountSettingsScope();
    const ownHome = isSameApprovalHome(viewer?.serverId, approvalServerId);
    const artifact = useArtifact((reference?.kind === 'skill' || reference?.kind === 'artifact') && ownHome ? reference.id : '');
    const machine = useServerScopedMachine(approvalServerId, reference?.kind === 'machine' ? reference.id : '');
    const sessionMachine = useServerScopedMachine(serverId, reference?.kind === 'session' ? sessionReading.machineId : '');
    const mcp = useMcpServerCatalogForServer(reference?.kind === 'mcpServer' ? approvalServerId : null, reference?.kind === 'mcpServer');
    const registries = usePromptLibraryCatalogValue('registry-sources', reference?.kind === 'registrySource' && ownHome ? viewer : null);
    const projects = useProjectAccountRows();
    const agents = useAgentCatalogIdentities({ agentIds: reference?.kind === 'agent' ? [reference.id] : [], machineId: null,
        serverId: reference?.kind === 'agent' ? approvalServerId : null });
    const providerCatalog = useProviderCatalogForServer(reference?.kind === 'providerConnection' ? approvalServerId : null);
    const declarations = readAccountProviderDeclarations();
    return resolveApprovalReferenceReading(reference, literal, approvalServerId, { serverId, sessionReading, viewer, ownHome, artifact, machine, sessionMachine, mcp, registries, projects, agents, providerCatalog, declarations });
}

type ApprovalReferenceSources = {
    serverId: string | null;
    sessionReading: Pick<ReturnType<typeof useApprovalSessionReading>, 'name' | 'machineId' | 'status'>;
    viewer: ReturnType<typeof useAccountSettingsScope>;
    ownHome: boolean;
    artifact?: DecryptedArtifact | null;
    machine?: ReturnType<typeof useServerScopedMachine>;
    sessionMachine?: ReturnType<typeof useServerScopedMachine>;
    mcp?: ReturnType<typeof useMcpServerCatalogForServer>;
    registries?: Pick<ReturnType<typeof usePromptLibraryCatalogValue<'registry-sources'>>, 'value'>;
    projects?: ReturnType<typeof useProjectAccountRows>;
    agents?: ReturnType<typeof useAgentCatalogIdentities>;
    providerCatalog?: ReturnType<typeof useProviderCatalogForServer>;
    declarations: ReturnType<typeof readAccountProviderDeclarations>;
};

function resolveApprovalReferenceReading(reference: ApprovalReference | undefined, literal: string, approvalServerId: string | null, sources: ApprovalReferenceSources): ApprovalReferenceReading {
    const { serverId, sessionReading, viewer, ownHome, artifact, machine, sessionMachine, mcp, registries, projects, agents, providerCatalog, declarations } = sources;
    if (reference?.kind === 'skill' || reference?.kind === 'artifact') return readApprovalArtifactReference(reference, ownHome ? artifact : null);
    if (reference?.kind === 'machine') {
        const title = getMachineDisplayName(machine) ?? reference.id;
        // The row's own label already names the kind ("Machine"); the value is just its name.
        return { text: reference.workspaceRoot ? `${formatPathRelativeToHome(reference.workspaceRoot)} · ${title}` : title, named: Boolean(machine) };
    }
    if (reference?.kind === 'mcpServer') {
        const server = mcp?.value?.servers.find(row => row.id === reference.id);
        return { text: server ? mcpServerDisplayName(server) : reference.id, named: Boolean(server) };
    }
    if (reference?.kind === 'registrySource') {
        const source = registries?.value?.sources.find(row => row.id === reference.id)
            ?? BUILT_IN_REGISTRY_SOURCES_V1.find(row => row.id === reference.id);
        return { text: source?.title ?? reference.id, named: Boolean(source) };
    }
    if (reference?.kind === 'project') {
        const title = ownHome && projects && projects.scope.accountId === viewer?.accountId
            && isSameApprovalHome(projects.scope.serverId, approvalServerId)
            ? projects.organizations.find(row => row.key.projectKey === reference.id)?.value.label : null;
        return { text: title ?? reference.id, named: Boolean(title) };
    }
    if (reference?.kind === 'agent') {
        const title = agents?.map(row => row.entry.title).join(', ') ?? '';
        return { text: title || reference.id, named: Boolean(title) };
    }
    if (reference?.kind === 'setting') {
        const setting = builtInSettingUiDeclaration(reference.id);
        return { text: t(setting.titleKey), named: true };
    }
    if (reference?.kind === 'providerContribution') {
        const declaration = declarations.find(row => areProviderContributionKeysEqualV1(row.contributionKey, reference.id));
        return { text: declaration?.definition.name ?? t('common.unavailable'), named: true };
    }
    if (reference?.kind === 'providerConnection') {
        const connection = providerCatalog?.data?.connections.find(row => row.id === reference.id);
        if (connection) {
            const sourceName = connection.source.kind === 'custom' ? connection.source.template.name
                : declarations.find(row => connection.source.kind === 'contribution'
                    && areProviderContributionKeysEqualV1(row.contributionKey, connection.source.contributionKey))?.definition.name;
            return { text: presentProviderConnectionIdentity({ ...connection,
                providerName: sourceName ?? t('common.unavailable') }).title, named: true };
        }
        return { text: reference.displayName ?? t('common.unavailable'), named: true };
    }
    if (reference?.kind === 'session') {
        if (sessionReading.status === 'resolving') return { text: t('common.loading'), named: false, resolving: true };
        const title = sessionReading.name ?? describeUnnamedApprovalSession(resolveApprovalHomeSentenceName(serverId));
        if (reference.presentation !== 'destructive_target') return { text: title, named: true };
        const machineName = getMachineDisplayName(sessionMachine)
            ?? (sessionReading.machineId || t('common.unavailable'));
        return {
            text: `${title} · ${t('contextBar.machine')} ${machineName} · …${reference.id.slice(-8)}`,
            named: true,
        };
    }
    if (reference?.kind === 'home') {
        const home = resolveApprovalHomeName(reference.id)
            ?? (isSameApprovalHome(reference.id, approvalServerId) ? t('settingsAccount.thisHomeTitle') : null);
        return home === null ? { text: literal, named: false } : { text: home, named: true };
    }
    if (reference?.kind === 'account') {
        const own = viewer !== null && viewer.accountId === reference.id && isSameApprovalHome(viewer.serverId, approvalServerId);
        return own ? { text: t('accountDisplay.yours'), named: true } : { text: literal, named: false };
    }
    return { text: literal, named: false };
}

/**
 * Whether two Home ids name one Home on this device. A request may carry the Home's portable identity
 * where this device addresses it by its own profile id; the profile owner resolves both.
 */
function isSameApprovalHome(left: string | null | undefined, right: string | null | undefined): boolean {
    const a = left?.trim();
    const b = right?.trim();
    if (!a || !b) return false;
    if (a === b) return true;
    const profile = getServerProfileById(a);
    return profile !== null && profile.id === getServerProfileById(b)?.id;
}

