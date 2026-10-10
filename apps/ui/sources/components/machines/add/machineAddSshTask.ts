import type { SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import type { RemoteSshBootstrapFormState } from '@/components/systemTasks/remoteSshBootstrap/useRemoteSshBootstrapTask';
import { buildRemoteSshBootstrapFormStateFromSshConfig, resolveRemoteSshBootstrapFormState } from '@/components/onboarding/checklists/remoteSsh/resolveRemoteSshBootstrapFormState';
import { persistRemoteHostAfterRemoteSshCompletion } from '@/components/onboarding/checklists/remoteSsh/persistRemoteHostAfterRemoteSshCompletion';
import { observeRemoteHostSystemTaskCompletion, startAdmittedRemoteHostSystemTask } from '@/components/settings/remoteHosts/remoteHostTaskOperations';
import { buildSshCredentialsDraftFromRemoteHostConfig } from '@/components/settings/remoteHosts/remoteHostOutcomeActions';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readRemoteHostFeatureDecisions, withRemoteHostSshConfig } from '@/sync/ops/remoteHosts/remoteHostOperations';
import { readRemoteHostCatalogForOperationInContext } from '@/sync/api/account/apiRemoteHostCatalog';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { storage } from '@/sync/domains/state/storageStore';
import { updateMachineAddFlowDraft, type MachineAddSshDraft } from './machineAddFlowStore';
import { beginMachineAddWatch, startMachineAddTask } from './machineAddTaskLifetime';

type SshTaskInput = Readonly<{ runner: SystemTaskRunner; serverId: string; draft: MachineAddSshDraft; signal?: AbortSignal; assertCurrent?(): void }>;
type RunWithForm<T> = (form: RemoteSshBootstrapFormState, startSpec: (spec: SystemTaskSpec) => Promise<string>) => Promise<T>;
type CompletionPersistence = Parameters<typeof persistRemoteHostAfterRemoteSshCompletion>[0];

/** The native runner has no SSH-agent transport; both presenters consume this capability fact. */
export function getMachineAddSshSupportedAuthModes(runner: SystemTaskRunner) {
    return runner.mode === 'native' ? ['keyfile', 'password'] as const : ['agent', 'keyfile', 'password'] as const;
}

function assertSupportedAuth(runner: SystemTaskRunner, mode: MachineAddSshDraft['authMode']) {
    if (!getMachineAddSshSupportedAuthModes(runner).some(supported => supported === mode)) throw new Error('ssh_auth_mode_unavailable');
}

/** Saved credentials are borrowed only inside the existing revision-bound host admission. */
export async function runWithMachineAddSshForm<T>(input: SshTaskInput, run: RunWithForm<T>,
    captureCompletion?: (persistence: Omit<CompletionPersistence, 'completion'>) => void): Promise<T> {
    const expectedScope = storage.getState().settingsScope;
    const assertCurrent = () => {
        input.signal?.throwIfAborted();
        input.assertCurrent?.();
        if (!areAccountSettingsScopesEqual(storage.getState().settingsScope, expectedScope)) throw new Error('action_account_scope_changed');
    };
    const lifetime = captureActiveServerAccountScopeLifetime();
    const account = input.draft.savedHostId || captureCompletion && lifetime
        ? await captureLazyActionAccountContext(input.serverId, input.signal) : null;
    try {
        assertCurrent();
        if (account && !areAccountSettingsScopesEqual(account.accountLifetime.scope, expectedScope)) throw new Error('action_account_scope_changed');
        const startSpec = (admit: () => void) => async (spec: SystemTaskSpec) => (await startAdmittedRemoteHostSystemTask({
            runner: input.runner, signal: input.signal, assertCurrent: () => { assertCurrent(); admit(); },
        }, spec)).taskId;
        const capture = (features: Awaited<ReturnType<typeof readRemoteHostFeatureDecisions>>, expectedRevision: number | 'absent',
            host?: CompletionPersistence['host']) => captureCompletion?.({ ...features, expectedRevision, host,
                scope: account?.accountLifetime.scope ?? null, selectedSavedRemoteHostId: input.draft.savedHostId ?? '__new__', newHostSentinelId: '__new__',
                runContext: { selectedSavedRemoteHostId: input.draft.savedHostId ?? '__new__', saveHost: true, saveSecretMaterial: false },
                // Completion records references and local paths; it never retains borrowed credential material.
                draft: { host: input.draft.host, username: input.draft.username, port: input.draft.port,
                    authMode: input.draft.authMode, identityFilePath: input.draft.identityFilePath, password: '' }, privateKeyMaterialDraft: '',
                assertCurrent: () => { if (!lifetime?.isCurrent()) throw new Error('action_account_scope_changed'); },
            });
        if (input.draft.savedHostId) {
            if (!account || input.draft.savedHostExpectedRevision === undefined) throw new Error('remote_host_catalog_unavailable');
            const expectedRevision = input.draft.savedHostExpectedRevision;
            return await withRemoteHostSshConfig(account, { hostId: input.draft.savedHostId, expectedRevision },
                async ({ host, config, assertCurrent: assertHostCurrent }) => {
                    assertSupportedAuth(input.runner, config.value.sshAuth);
                    if (captureCompletion) capture(await readRemoteHostFeatureDecisions(account), expectedRevision, host);
                    const form = buildRemoteSshBootstrapFormStateFromSshConfig({ config: config.value, draft: input.draft, installRelayRuntime: false });
                    assertHostCurrent();
                    assertCurrent();
                    if (captureCompletion) updateMachineAddFlowDraft(current => ({ ...current, sshDraft: {
                        ...buildSshCredentialsDraftFromRemoteHostConfig({ ...config.value, password: '', identityPrivateKey: '' }),
                        savedHostId: host.id, savedHostExpectedRevision: input.draft.savedHostExpectedRevision,
                    } }));
                    return run(form, startSpec(assertHostCurrent));
                }, input.signal);
        }
        assertSupportedAuth(input.runner, input.draft.authMode);
        if (account && captureCompletion) {
            // Host saving remains best-effort; an unavailable optional catalog does not veto new-machine setup.
            try {
                const features = await readRemoteHostFeatureDecisions(account);
                if (features.managementEnabled) {
                    const catalog = await readRemoteHostCatalogForOperationInContext(account, input.signal);
                    account.assertCurrent();
                    if (catalog.status === 'ready') capture(features, catalog.revision);
                }
            } catch { assertCurrent(); account.assertCurrent(); }
        }
        const form = await resolveRemoteSshBootstrapFormState({ draft: input.draft, usingSavedHost: false, selectedSavedHost: null,
            privateKeyMaterialDraft: input.draft.privateKeyMaterial ?? '', saveSecretMaterial: false, installRelayRuntime: false,
            remoteHostsSecretMaterialEnabled: false });
        return run(form, startSpec(() => account?.assertCurrent()));
    } finally { account?.dispose(); }
}

/** UI and Actions share admitted setup, retained task lifetime and completion persistence. */
export function startMachineAddSshTask(input: SshTaskInput, run: RunWithForm<string>) {
    const lifetime = captureActiveServerAccountScopeLifetime();
    const runner = input.runner;
    let persistence: Omit<CompletionPersistence, 'completion'> | undefined;
    const observeCompletion = (taskId: string) => lifetime ? observeRemoteHostSystemTaskCompletion({
        runner, taskId, lifetime, onSuccess: completion => {
            if (persistence) void persistRemoteHostAfterRemoteSshCompletion({ ...persistence, completion }).catch(() => {});
        },
    }) : () => {};
    return startMachineAddTask('ssh', runner, isCurrent => runWithMachineAddSshForm({ ...input, assertCurrent: () => {
        input.assertCurrent?.();
        if (!isCurrent()) throw new Error('machine_setup_not_started');
    } }, async (form, startSpec) => {
        if (!isCurrent()) throw new Error('machine_setup_not_started');
        beginMachineAddWatch(input.serverId, 'ssh');
        return run(form, startSpec);
    }, captured => { persistence = captured; }), observeCompletion);
}
