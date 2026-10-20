import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { PluginProjectionEditableSettingField } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { storage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { getMachineContributionRegistryProjectionRevision } from '@/sync/ops/machineContributionRegistryProjection';
import { resolveScopedPluginSettingsTarget, type ScopedPluginSettingsScope } from './scopedPluginSettingsAdapter';
import { resolveScopedPluginSettingsServerIdentity, scopedPluginSettingsAdapter } from './scopedPluginSettingsRuntime';
import { commitScopedPluginSettingsField, projectScopedPluginSettingsField } from './scopedPluginSettingsProjection';

/** Agent-declared candidates persist only while their exact settings authority remains current. */
export type DeclaredAskUserQuestionSettingMutation = Readonly<{
    sessionId: string;
    serverId: string;
    agentId: string;
    machineId: string;
    pluginId: string;
    agentLocalId: string;
    dialogId: string;
    settingId: string;
    fieldId: string;
    projectionGeneration: number;
    projectionRevision: number;
    scope: ScopedPluginSettingsScope;
    field: PluginProjectionEditableSettingField;
    value: string;
}>;

export async function persistDeclaredAskUserQuestionSetting(
    input: DeclaredAskUserQuestionSettingMutation & Readonly<{
        resolveCurrentDeclaration: () => DeclaredAskUserQuestionSettingMutation | null;
    }>,
): Promise<void> {
    const serverId = input.serverId;
    const target = resolveScopedPluginSettingsTarget({
        scope: input.scope,
        serverIdentityId: resolveScopedPluginSettingsServerIdentity(serverId),
        machineId: input.machineId,
        serverId,
    });
    if (!target) {
        throw new Error(input.scope.kind === 'account'
            ? 'Unable to persist the selected setting without an exact Account target.'
            : 'Unable to persist the selected setting without an exact daemon target.');
    }
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) {
        throw new Error('Unable to persist the selected setting outside the active Account lifetime.');
    }
    const projectedField = projectScopedPluginSettingsField(input.field);
    if (projectedField.binding?.kind === 'perActiveServer') {
        throw new Error('Unable to persist a selected setting with a server-dependent binding.');
    }
    const isTargetCurrent = (): boolean => {
        const currentSession = storage.getState().sessions[input.sessionId];
        const currentServerId = typeof currentSession?.serverId === 'string'
            ? currentSession.serverId.trim()
            : '';
        if (currentServerId !== serverId) return false;
        const metadata = currentSession ? readSessionOwnerMetadataView(currentSession) : null;
        if (
            resolveAgentIdFromSessionMetadata(metadata) !== input.agentId
            || resolveSessionMachineId(metadata) !== input.machineId
        ) {
            return false;
        }
        const currentDeclaration = input.resolveCurrentDeclaration();
        if (
            !currentDeclaration
            || getMachineContributionRegistryProjectionRevision({
                machineId: input.machineId,
                serverId,
            }) !== input.projectionRevision
        ) {
            return false;
        }
        return currentDeclaration.sessionId === input.sessionId
            && currentDeclaration.serverId === input.serverId
            && currentDeclaration.agentId === input.agentId
            && currentDeclaration.machineId === input.machineId
            && currentDeclaration.pluginId === input.pluginId
            && currentDeclaration.agentLocalId === input.agentLocalId
            && currentDeclaration.dialogId === input.dialogId
            && currentDeclaration.settingId === input.settingId
            && currentDeclaration.fieldId === input.fieldId
            && currentDeclaration.value === input.value
            && currentDeclaration.projectionGeneration === input.projectionGeneration
            && currentDeclaration.projectionRevision === input.projectionRevision
            && currentDeclaration.scope.kind === input.scope.kind;
    };
    const result = await commitScopedPluginSettingsField({
        pluginId: input.pluginId,
        scope: input.scope,
        target,
        accountLifetime,
        fields: [projectedField],
        adapter: scopedPluginSettingsAdapter,
        fieldId: input.fieldId,
        mutation: { kind: 'set', value: input.value },
        isCurrent: isTargetCurrent,
    });
    if (result?.status === 'declined') return;
    if (result?.status !== 'ready' && result?.status !== 'applied') {
        throw new Error('Unable to persist the selected setting.');
    }
}
