import { describe, expect, it } from 'vitest';

import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { createMachineFixture, renderHook } from '@/dev/testkit';
import { DEFAULT_NEW_SESSION_AUTOMATION_DRAFT } from '@/sync/domains/automations/automationDraft';
import { settingsParse } from '@/sync/domains/settings/settings';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { createNewSessionPromptStore } from './newSessionPromptStore';
import { useNewSessionAuthoringState } from './useNewSessionAuthoringState';

describe('useNewSessionAuthoringState', () => {
    it('applies the Windows window-name preference only to its Windows destination and retains it when returning there', async () => {
        const settings = settingsParse({ sessionWindowsTerminalWindowName: 'Existing Windows name',
            sessionWindowsRemoteSessionLaunchMode: 'windows_terminal' });
        const windowsMachine = createMachineFixture({ id: 'windows-machine',
            metadata: { ...createMachineFixture().metadata!, platform: 'win32' } });
        const params: Parameters<typeof useNewSessionAuthoringState>[0] = {
            automationDraft: DEFAULT_NEW_SESSION_AUTOMATION_DRAFT,
            automationFeatureEnabled: false,
            selectedMachineId: null,
            selectedMachine: null,
            targetServerId: 'home-a',
            selectedPath: '',
            directoryKind: 'path',
            executionTarget: { kind: 'temporary_computer', serverId: 'home-a', artifactTarget: 'linux-x64',
                workspace: { kind: 'choose_on_endpoint' } },
            organizationPlacement: { folderId: null, tagIds: [] },
            checkoutCreationDraft: null,
            promptStore: createNewSessionPromptStore('Create on the chosen destination'),
            staticAgentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            agentTarget: { kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex },
            transcriptStorage: 'persisted',
            useProfiles: false,
            selectedProfileId: null,
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: {},
            getSessionOnlySecretValueEncByProfileIdByEnvVarName: () => ({}),
            resumeSessionId: '',
            permissionMode: 'default',
            modelSelection: null,
            capabilitySelection: null,
            agentNewSessionOptions: null,
            settings,
            effectiveWindowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionLaunchModeOverride: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automationRequestedByRoute: false,
            backendNewSessionOptionStateByTargetKey: {},
        };
        let destination = params;
        const hook = await renderHook(() => useNewSessionAuthoringState(destination));
        try {
            expect(hook.getCurrent().currentAuthoringDraft.windowsTerminalWindowName).toBeNull();
            destination = { ...params, selectedMachine: windowsMachine, selectedMachineId: windowsMachine.id,
                selectedPath: 'C:\\repo', executionTarget: { kind: 'machine',
                    target: { serverId: 'home-a', machineId: windowsMachine.id } },
                effectiveWindowsRemoteSessionLaunchMode: resolveEffectiveWindowsRemoteSessionLaunchMode({
                    machineMetadata: windowsMachine.metadata, settings,
                }).mode ?? null };
            await hook.rerender();
            expect(hook.getCurrent().currentAuthoringDraft).toMatchObject({
                windowsRemoteSessionLaunchMode: 'windows_terminal', windowsTerminalWindowName: 'Existing Windows name',
            });
            destination = params;
            await hook.rerender();
            expect(hook.getCurrent().currentAuthoringDraft.windowsTerminalWindowName).toBeNull();
            expect(settings.sessionWindowsTerminalWindowName).toBe('Existing Windows name');
        } finally { await hook.unmount(); }
    });
});
