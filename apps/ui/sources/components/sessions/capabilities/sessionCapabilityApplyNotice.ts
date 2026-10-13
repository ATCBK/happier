import type { CapabilityApplyTimingV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import type { SessionCapabilitiesGetOutputV1 } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { t } from '@/text';
import { readAppliedSessionCapabilitySelectionFromMetadataV1, readSessionCapabilitySelectionFromMetadataV1, readPendingCapabilityApplyV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { readSessionCapabilityOverrideV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';

export type SessionCapabilityChange = Readonly<{ kind: 'skill' | 'mcp_server' | 'native_skill'; title: string; state: 'on' | 'off' | 'inherit' }>;
export type SessionCapabilityApplyNoticeKey = 'addedNow' | 'removedNow' | 'joinsNextTurn' | 'leavesNextTurn' | 'pendingNextTurn'
    | 'newSessionsOnly' | 'offline' | 'restart' | 'restartTerminal' | 'cannotResume' | 'nextStart' | 'saved';
export type SessionCapabilityApplyNotice = Readonly<{ key: SessionCapabilityApplyNoticeKey; text: string; restart: 'enabled' | 'disabled' | null }>;
type PendingApply = Extract<SessionCapabilitiesGetOutputV1, { ok: true }>['pendingApply'];

/** Every writer, including Agent approvals and $ picks, leaves the same desired/applied metadata. */
export function readSessionCapabilityApplyChange(metadata: unknown,
    titleFor: (kind: SessionCapabilityChange['kind'], id: string) => string | null): SessionCapabilityChange | null {
    const desired = readSessionCapabilitySelectionFromMetadataV1(metadata), applied = readAppliedSessionCapabilitySelectionFromMetadataV1(metadata);
    const pending = readPendingCapabilityApplyV1(metadata);
    const candidates: SessionCapabilityChange[] = [];
    const kinds = [
        ['mcp_server', pending.mcp, [...desired.mcp.forceIncludeServerIds, ...desired.mcp.forceExcludeServerIds, ...applied.mcp.forceIncludeServerIds, ...applied.mcp.forceExcludeServerIds]],
        ['skill', pending.skills, [...desired.skills.forceIncludeSkillIds, ...desired.skills.forceExcludeSkillIds, ...applied.skills.forceIncludeSkillIds, ...applied.skills.forceExcludeSkillIds]],
        ['native_skill', pending.skills, [...desired.skills.excludeNativeSkillNames, ...applied.skills.excludeNativeSkillNames]],
    ] as const;
    for (const [kind, changed, ids] of kinds) {
        if (!changed) continue;
        for (const id of new Set(ids)) {
            const state = readSessionCapabilityOverrideV1(desired, kind, id);
            if (state === readSessionCapabilityOverrideV1(applied, kind, id)) continue;
            const title = titleFor(kind, id);
            if (!title) return null;
            candidates.push({ kind, title, state });
        }
    }
    return candidates.length === 1 ? candidates[0]! : null;
}

/** Pure presentation of P2's acknowledged/pending facts, shared by sheet, mention picks and approvals. */
export function sessionCapabilityApplyNotice(input: Readonly<{
    pendingApply: PendingApply;
    applyTiming: Readonly<{ mcp: CapabilityApplyTimingV1; skills: CapabilityApplyTimingV1 }> | null;
    change: SessionCapabilityChange | null;
    machineOnline: boolean; machineName: string; turnSettled: boolean;
    translate?: (key: `capabilities.session.apply.${SessionCapabilityApplyNoticeKey}`, params: Readonly<{ item: string; machine: string }>) => string;
}>): SessionCapabilityApplyNotice | null {
    const pending = input.pendingApply.mcp || input.pendingApply.skills;
    const changeKind = input.change?.kind === 'mcp_server' ? 'mcp' : 'skills';
    const change = pending && !input.pendingApply[changeKind] ? null : input.change;
    const kind = change?.kind === 'mcp_server' ? 'mcp' : change ? 'skills' : input.pendingApply.mcp ? 'mcp' : 'skills';
    const timing = input.applyTiming?.[kind];
    if (!pending && !(input.change && timing?.t === 'applied_now')) return null;
    let key: SessionCapabilityApplyNoticeKey;
    let restart: SessionCapabilityApplyNotice['restart'] = null;
    if (input.pendingApply.reason === 'missing_resume_snapshot' || input.pendingApply.reason === 'missing_resume_identity') key = 'cannotResume';
    else if (!input.machineOnline) key = 'offline';
    else if (input.pendingApply.restartBy || timing?.t === 'restart_to_apply') {
        const by = input.pendingApply.restartBy ?? (timing?.t === 'restart_to_apply' ? timing.restartBy : null);
        key = by === 'terminal' ? 'restartTerminal' : 'restart';
        if (by === 'user') restart = input.turnSettled ? 'enabled' : 'disabled';
    } else if (timing?.t === 'new_sessions_only') key = 'newSessionsOnly';
    else if (timing?.t === 'session_not_running') key = 'nextStart';
    else if (!timing || timing.t === 'applied_now' && input.pendingApply[kind] || change?.state === 'inherit') key = 'saved';
    else if (change) key = timing?.t === 'applied_now' ? change.state === 'off' ? 'removedNow' : 'addedNow'
        : change.state === 'off' ? 'leavesNextTurn' : 'joinsNextTurn';
    else key = 'pendingNextTurn';
    return { key, text: (input.translate ?? t)(`capabilities.session.apply.${key}`, { item: change?.title ?? '', machine: input.machineName }), restart };
}
