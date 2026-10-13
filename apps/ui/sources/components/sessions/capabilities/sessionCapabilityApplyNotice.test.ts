import { describe, expect, it } from 'vitest';
import { readSessionCapabilityApplyChange, sessionCapabilityApplyNotice } from './sessionCapabilityApplyNotice';
import { readPendingCapabilityApplyV1, writeSessionCapabilitySelectionToMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { setSessionCapabilitySelectionItemV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import type { CapabilityApplyTimingV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import { SkillListItemV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { buildSkillComposerGroups, pickSkillComposerRow } from '@/sync/domains/skills/skillComposerGroups';
import { SessionCapabilitySelectionAuthoringV1Schema } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';

describe('the single session capability apply notice', () => {
    const translate = (key: string, params?: Readonly<Record<string, string>>) => JSON.stringify([key, params ?? {}]);
    it('uses the same desired/applied metadata producer for a dollar pick and a sheet edit', async () => {
        const item = SkillListItemV1Schema.parse({ skillId: 'skill', name: 'review', description: null, revision: '1:1', rules: [],
            trust: 'text_only', cost: { bodyTokens: 1, descriptionTokens: 0 }, provenance: { kind: 'written' }, modified: false,
            updatePolicy: 'manual', createdAt: 1, migratedFromContext: false, userInvocable: true, folderId: null });
        const row = buildSkillComposerGroups({ open: true, query: '', agentId: 'codex', machineId: null,
            sessionItems: [], libraryItems: [item], found: null })[0]!.rows[0]!;
        let selection = SessionCapabilitySelectionAuthoringV1Schema.parse({});
        const pick = await pickSkillComposerRow(row, { setItem: (kind, id, state) => {
            selection = setSessionCapabilitySelectionItemV1(selection, kind, id, state);
        } });
        expect(pick).toEqual({ ok: true, mention: { kind: 'happier.skill', ref: 'skill:skill', token: '$review', label: 'review' } });
        const pickedMetadata = writeSessionCapabilitySelectionToMetadataV1({}, selection, { sessionActive: true });
        const sheetMetadata = writeSessionCapabilitySelectionToMetadataV1({}, setSessionCapabilitySelectionItemV1({}, 'skill', 'skill', 'on'), { sessionActive: true });
        const notice = (metadata: unknown) => sessionCapabilityApplyNotice({ pendingApply: readPendingCapabilityApplyV1(metadata),
            applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'next_turn' } },
            change: readSessionCapabilityApplyChange(metadata, () => 'Review'), machineOnline: true, machineName: 'MacBook', turnSettled: true, translate });
        expect(notice(pickedMetadata)).toEqual(notice(sheetMetadata));
        expect(notice(pickedMetadata)?.key).toBe('joinsNextTurn');
    });
    it('reads every surface’s real desired/applied metadata and uses one generic line for several changes', () => {
        const selection = setSessionCapabilitySelectionItemV1({}, 'mcp_server', 'linear', 'on');
        const metadata = writeSessionCapabilitySelectionToMetadataV1({}, selection, { sessionActive: true });
        expect(readSessionCapabilityApplyChange(metadata, () => 'Linear')).toEqual({ kind: 'mcp_server', title: 'Linear', state: 'on' });
        const two = writeSessionCapabilitySelectionToMetadataV1(metadata, setSessionCapabilitySelectionItemV1(selection, 'native_skill', 'review', 'off'), { sessionActive: true });
        expect(readSessionCapabilityApplyChange(two, (_kind, id) => id)).toBeNull();
        expect(readSessionCapabilityApplyChange(metadata, () => null)).toBeNull();
    });
    it('does not promise next-turn application while runtime timing is unavailable', () => {
        expect(sessionCapabilityApplyNotice({ pendingApply: { mcp: true, skills: false }, applyTiming: null,
            change: { kind: 'mcp_server', title: 'Linear', state: 'on' }, machineOnline: true, machineName: 'MacBook',
            turnSettled: true, translate })?.key).toBe('saved');
    });
    it('waits for the host live-reload acknowledgment before saying applied now', () => {
        const input = { pendingApply: { mcp: false, skills: true }, applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } } as const,
            change: { kind: 'skill', title: 'Review', state: 'on' } as const, machineOnline: true, machineName: 'MacBook', turnSettled: true, translate };
        expect(sessionCapabilityApplyNotice(input)?.key).toBe('saved');
        expect(sessionCapabilityApplyNotice({ ...input, pendingApply: { mcp: false, skills: false } })?.key).toBe('addedNow');
    });
    it.each([
        [{ t: 'applied_now' }, 'on', 'addedNow'], [{ t: 'applied_now' }, 'off', 'removedNow'],
        [{ t: 'next_turn' }, 'on', 'joinsNextTurn'], [{ t: 'next_turn' }, 'off', 'leavesNextTurn'],
        [{ t: 'new_sessions_only' }, 'on', 'newSessionsOnly'], [{ t: 'session_not_running' }, 'on', 'nextStart'],
        [{ t: 'restart_to_apply', restartBy: 'user' }, 'on', 'restart'],
        [{ t: 'restart_to_apply', restartBy: 'terminal' }, 'on', 'restartTerminal'],
    ] as const)('projects %j/%s without deciding apply timing again', (timing, state, key) => {
        const notice = sessionCapabilityApplyNotice({ pendingApply: { mcp: timing.t !== 'applied_now', skills: false },
            applyTiming: { mcp: timing as CapabilityApplyTimingV1, skills: { t: 'applied_now' } },
            change: { kind: 'mcp_server', title: 'Linear', state }, machineOnline: true, machineName: 'MacBook',
            turnSettled: true, translate });
        expect(notice?.key).toBe(key);
        expect(notice?.restart).toBe(timing.t === 'restart_to_apply' && timing.restartBy === 'user' ? 'enabled' : null);
    });
    it('reads pending and refusal facts for both kinds and clears after acknowledgment', () => {
        const input = { pendingApply: { mcp: false, skills: true }, applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'next_turn' } } as const,
            change: { kind: 'native_skill', title: 'Review', state: 'off' } as const, machineOnline: true, machineName: 'MacBook', turnSettled: false, translate };
        expect(sessionCapabilityApplyNotice(input)?.key).toBe('leavesNextTurn');
        expect(sessionCapabilityApplyNotice({ ...input, pendingApply: { mcp: false, skills: false }, change: null })).toBeNull();
        expect(sessionCapabilityApplyNotice({ ...input, machineOnline: false })?.key).toBe('offline');
        expect(sessionCapabilityApplyNotice({ ...input, pendingApply: { ...input.pendingApply, reason: 'missing_resume_snapshot' } })?.key).toBe('cannotResume');
        expect(sessionCapabilityApplyNotice({ ...input, applyTiming: { ...input.applyTiming, skills: { t: 'restart_to_apply', restartBy: 'user' } } })?.restart).toBe('disabled');
    });
    it('shows an acknowledged live edit once; a refreshable producer never fabricates zero cost or an item name', () => {
        const input = { pendingApply: { mcp: false, skills: false }, applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } } as const,
            change: { kind: 'skill', title: 'Review', state: 'on' } as const, machineOnline: true, machineName: 'MacBook', turnSettled: true, translate };
        expect(sessionCapabilityApplyNotice(input)?.key).toBe('addedNow');
        expect(sessionCapabilityApplyNotice({ ...input, change: null })).toBeNull();
    });
});
