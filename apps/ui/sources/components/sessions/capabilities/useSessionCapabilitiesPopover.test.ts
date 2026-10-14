import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { renderHook, createSessionFixture, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionOwnerCompatibilityViewV1,
    SessionMetadataOwnerPatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { SkillListItemV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { buildSkillComposerGroups, pickSkillComposerRow } from '@/sync/domains/skills/skillComposerGroups';
import { resolveSelectionRestartMarkersForStartupV1, writeCapabilitySelectionApplyV1, clearCapabilitySelectionApplyV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { MetadataSchema } from '@happier-dev/session-core/state';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
// Only the remote Machine RPC transport is substituted; P2 preview/selection and UI models are real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport }));
await loadSyncSingletonForTests();
const { useNewSessionCapabilitiesPopover, useExistingSessionCapabilitiesPopover } = await import('./useSessionCapabilitiesPopover');
const { getStorage } = await import('@/sync/domains/state/storageStore');

const presentation = { rules: () => [], mcpStatus: () => [], skillStatus: () => [],
    names: { agentName: () => 'Codex', machineName: () => 'MacBook', projectName: (key: string) => key, folderLabel: () => '~/repo' },
    nativeSkills: { items: [{ name: 'native-review', path: '/skills/review' }], canDisable: true, machineName: 'MacBook', agentName: 'Codex',
        applyTiming: { t: 'next_turn' as const } }, machineOnline: true, machineName: 'MacBook', turnSettled: true };
const preview = { ok: true, machinePlatform: 'posix', mcp: { strictMode: false, items: [], detected: [] },
    skills: { items: [], plan: { plan: 'none', items: [], nativeDisables: [], diagnostics: [] } },
    applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } } };
let serverId: string;
beforeEach(async () => {
    await homes.reset(); await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Session Home', serverUrl: 'https://popover-capabilities.test', accountId: 'owner' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    transport.mockReset(); transport.mockResolvedValue(preview);
});
afterEach(async () => { standardCleanup(); await homes.reset(); });

it('edits only the authoring draft and does not request a Machine preview before demand', async () => {
    const hook = await renderHook(() => {
        const [selection, setSelection] = React.useState<SessionCapabilitySelectionV1>({
            mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['linear'], forceExcludeServerIds: [] } });
        return useNewSessionCapabilitiesPopover({ machineId: 'machine', directory: '/repo', agentId: 'codex', enabled: true,
            selection, setSelection }, presentation);
    });
    expect(transport).not.toHaveBeenCalled();
    await act(async () => hook.getCurrent().setItem('native_skill', 'native-review', 'off'));
    expect(hook.getCurrent().model.groups[0]?.nativeRow?.rows[0]).toMatchObject({ dimmed: true, action: { kind: 'turn_on' } });
    expect(homes.requests.some(request => request.input !== null && request.path.includes('/sessions/'))).toBe(false);
    await act(async () => hook.getCurrent().demandPreview());
    await vi.waitFor(() => expect(hook.getCurrent().model.state, hook.getCurrent().error ?? '').toBe('ready'));
});

it('reuses the Session Action owner for rollback, previous-override Undo and read-only viewers', async () => {
    const sessionId = 'c123456789012345678901234';
    const initial = createSessionOwnerMetadataV1({ metadata: { path: '/repo', host: 'MacBook', machineId: 'machine', flavor: 'codex', startedBy: 'daemon',
        runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} },
        agentRuntimeCapabilitiesV1: { capabilitySelection: { vendorResume: 'supported', skillsLiveReload: 'supported' } },
        skillSelectionV1: { v: 1, forceIncludeSkillIds: [], forceExcludeSkillIds: [], excludeNativeSkillNames: ['native-review'] } } });
    if (!initial.ok) throw new Error('Invalid owner fixture');
    let row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 1,
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(initial.ownerMetadata), agentState: null, agentStateVersion: 1,
        dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
    const metadata = () => row.ownerMetadata?.t === 'plain' ? MetadataSchema.parse(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: { v: 1 }, ownerMetadata: row.ownerMetadata.v })) : null;
    getStorage().setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId, active: true, metadataLayoutVersion: 1,
        metadata: { path: '', host: '' }, ownerMetadataView: metadata() }) }, sessionLocalStateScope: { serverId, accountId: 'owner' } });
    let conflict = false;
    for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`, { select: () => {
        const response = { body: { session: row } };
        if (conflict) { conflict = false; row = { ...row, metadataVersion: row.metadataVersion + 1 }; }
        return response;
    } });
    homes.answer(serverId, `PATCH /v2/sessions/${sessionId}`, { select: input => {
        const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
        expect(patch.sharedMetadata.expectedVersion).toBe(row.metadataVersion);
        row = { ...row, ownerMetadata: patch.ownerMetadata, metadata: patch.sharedMetadata.ciphertext, metadataVersion: row.metadataVersion + 1,
            agentState: patch.agentState.ciphertext, agentStateVersion: row.agentStateVersion! + 1 };
        return { body: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
    } });
    const target = { kind: 'session' as const, sessionId, serverId, readOnly: false };
    homes.answer(serverId, 'GET /v1/artifacts', { body: [] });
    const hook = await renderHook((readOnly: boolean) => useExistingSessionCapabilitiesPopover({ ...target, readOnly }, presentation), { initialProps: false });
    expect(transport).not.toHaveBeenCalled();
    await act(async () => { expect(await hook.getCurrent().setItem('native_skill', 'native-review', 'on')).toEqual({ ok: true }); });
    expect(hook.getCurrent().selection.skills?.excludeNativeSkillNames).toEqual([]);
    await act(async () => { expect(await hook.getCurrent().undoLast()).toEqual({ ok: true }); });
    expect(hook.getCurrent().selection.skills?.excludeNativeSkillNames).toEqual(['native-review']);
    conflict = true;
    await act(async () => { expect(await hook.getCurrent().setItem('native_skill', 'native-review', 'on')).toEqual({ ok: false, message: 'conflict' }); });
    expect(hook.getCurrent().selection.skills?.excludeNativeSkillNames).toEqual(['native-review']);
    await act(async () => { hook.getCurrent().demandPreview(); });
    await vi.waitFor(() => expect(hook.getCurrent().model.state).toBe('ready'));
    const builtIn = SkillListItemV1Schema.parse({ skillId: 'happier:happier', name: 'happier', description: null, revision: '1:1', rules: [],
        trust: 'text_only', cost: { descriptionTokens: 0, bodyTokens: 1 }, provenance: { kind: 'first_party' }, modified: false,
        updatePolicy: 'manual', createdAt: 0, migratedFromContext: false, userInvocable: true, folderId: null });
    const pickRow = buildSkillComposerGroups({ open: true, query: '', agentId: 'codex', machineId: 'machine',
        sessionItems: [], libraryItems: [builtIn], found: null })[0]!.rows[0]!;
    await act(async () => {
        const result = await pickSkillComposerRow(pickRow, hook.getCurrent());
        expect(result, JSON.stringify({ result, paths: homes.requests.map(request => request.path) })).toMatchObject({ ok: true });
    });
    expect(hook.getCurrent().selection.skills?.forceIncludeSkillIds).toContain('happier:happier');
    // Simulate the external runtime's acknowledged applied selection through its real metadata codec.
    const applied = resolveSelectionRestartMarkersForStartupV1({ current: metadata() ?? {}, applied: hook.getCurrent().selection });
    const acknowledged = createSessionOwnerMetadataV1({ metadata: applied });
    if (!acknowledged.ok) throw new Error('Invalid acknowledged metadata');
    row = { ...row, ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(acknowledged.ownerMetadata) };
    await act(async () => {
        const state = getStorage().getState();
        getStorage().setState({ sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId]!, ownerMetadataView: metadata() } } });
    });
    expect(hook.getCurrent().model.pendingNote).toContain('happier');
    expect(hook.getCurrent().model.applyNotice).toMatchObject({ key: 'addedNow', text: hook.getCurrent().model.pendingNote });
    // The same sheet controller owns the live receipt, including a title absent from its preview.
    const dollarNotice = hook.getCurrent().model.pendingNote;
    await act(async () => { expect(await hook.getCurrent().setItem('skill', 'happier:happier', 'on', 'happier')).toEqual({ ok: true }); });
    expect(hook.getCurrent().model.pendingNote).toBe(dollarNotice);
    // A later rule change supersedes that old local receipt; its acknowledgment
    // must clear the single line instead of resurrecting the earlier edit.
    const rulePending = writeCapabilitySelectionApplyV1(metadata() ?? {}, { skills: { source: 'rules', reason: 'next_turn' } });
    for (const [value, key] of [[rulePending, 'pendingNextTurn'], [clearCapabilitySelectionApplyV1(rulePending, 'skills'), null]] as const) {
        const owner = createSessionOwnerMetadataV1({ metadata: value });
        if (!owner.ok) throw new Error('Invalid rule status fixture');
        row = { ...row, ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata) };
        await act(async () => getStorage().setState(current => ({ sessions: { ...current.sessions, [sessionId]: {
            ...current.sessions[sessionId]!, ownerMetadataView: metadata(),
        } } })));
        expect(hook.getCurrent().model.applyNotice?.key ?? null).toBe(key);
    }
    await hook.rerender(true);
    await expect(hook.getCurrent().setItem('native_skill', 'native-review', 'on')).resolves.toEqual({ ok: false, message: 'read_only' });
    await expect(hook.getCurrent().undoLast()).resolves.toEqual({ ok: false, message: 'read_only' });
    expect(hook.getCurrent().model.groups[0]?.nativeRow?.rows[0]?.action.kind).toBe('none');
});
