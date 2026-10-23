import type { LiveActivityApnsPriority, LiveActivityApnsTemplate } from '@happier-dev/protocol';

import { readSessionAwarenessPresentationRankV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';

import type { LiveActivitySnapshot } from './buildLiveActivitySnapshots';
import type { LiveActivityAuthorizationDiagnostics } from './readLiveActivityAuthorizationDiagnostics';

const FOREGROUND_LIVE_ACTIVITY_UPDATE_MIN_INTERVAL_MS = 1_000;
const BACKGROUND_LIVE_ACTIVITY_UPDATE_MIN_INTERVAL_MS = 30_000;

export type LiveActivityRuntimeVisibility =
    | 'foreground_unlocked'
    | 'background_or_locked';

export type LiveActivityUpdateBudget = Readonly<{
    template: LiveActivityApnsTemplate;
    apnsPriority: LiveActivityApnsPriority;
    minimumIntervalMs: number;
}>;

export type LiveActivityRuntimeDiagnostics = Readonly<{
    state: 'available' | 'runtime_unavailable';
    reason: 'available' | 'app_backgrounded_or_locked' | 'native_bridge_unavailable';
}>;

export type LiveActivityUpdateDecision = Readonly<{
    shouldApply: boolean;
    reason: 'first_update' | 'budget_elapsed' | 'throttled';
    elapsedMs: number | null;
    minimumIntervalMs: number;
}>;

/** ActivityKit relevance scales the same Protocol priority used by the list and foreground path. */
export function resolveLiveActivityRelevanceScore(attentionState: LiveActivitySnapshot['attentionState']): number {
    return Math.round(readSessionAwarenessPresentationRankV1(attentionState)
        / readSessionAwarenessPresentationRankV1('failed') * 100);
}

export function resolveLiveActivityRuntimeVisibility(params: Readonly<{
    appStateStatus: string | null | undefined;
}>): LiveActivityRuntimeVisibility {
    return params.appStateStatus === 'active'
        ? 'foreground_unlocked'
        : 'background_or_locked';
}

export function resolveLiveActivityRuntimeDiagnostics(params: Readonly<{
    appStateStatus: string | null | undefined;
    bridgeAvailable: boolean;
}>): LiveActivityRuntimeDiagnostics {
    if (!params.bridgeAvailable) {
        return {
            state: 'runtime_unavailable',
            reason: 'native_bridge_unavailable',
        };
    }
    if (resolveLiveActivityRuntimeVisibility(params) === 'background_or_locked') {
        return {
            state: 'runtime_unavailable',
            reason: 'app_backgrounded_or_locked',
        };
    }
    return {
        state: 'available',
        reason: 'available',
    };
}

export function resolveLiveActivityUpdateBudget(params: Readonly<{
    attentionState: LiveActivitySnapshot['attentionState'];
    runtimeVisibility: LiveActivityRuntimeVisibility;
    frequentUpdates?: LiveActivityAuthorizationDiagnostics['frequentUpdates'];
}>): LiveActivityUpdateBudget {
    const urgent = readSessionAwarenessPresentationRankV1(params.attentionState) >= Math.min(
        readSessionAwarenessPresentationRankV1('permission_required'),
        readSessionAwarenessPresentationRankV1('action_required'),
    );
    const urgentPriorityAllowed = params.frequentUpdates !== 'disabled';

    return {
        template: urgent ? 'urgentAttention' : 'quietFocus',
        apnsPriority: urgent && urgentPriorityAllowed ? 10 : 5,
        minimumIntervalMs: params.runtimeVisibility === 'background_or_locked'
            ? BACKGROUND_LIVE_ACTIVITY_UPDATE_MIN_INTERVAL_MS
            : FOREGROUND_LIVE_ACTIVITY_UPDATE_MIN_INTERVAL_MS,
    };
}

export function shouldApplyLiveActivityUpdate(params: Readonly<{
    budget: LiveActivityUpdateBudget;
    lastAppliedAtMs: number | null | undefined;
    nowMs: number;
}>): boolean {
    return resolveLiveActivityUpdateDecision(params).shouldApply;
}

export function resolveLiveActivityUpdateDecision(params: Readonly<{
    budget: LiveActivityUpdateBudget;
    lastAppliedAtMs: number | null | undefined;
    nowMs: number;
}>): LiveActivityUpdateDecision {
    if (typeof params.lastAppliedAtMs !== 'number') {
        return {
            shouldApply: true,
            reason: 'first_update',
            elapsedMs: null,
            minimumIntervalMs: params.budget.minimumIntervalMs,
        };
    }

    const elapsedMs = params.nowMs - params.lastAppliedAtMs;
    const shouldApply = elapsedMs >= params.budget.minimumIntervalMs;
    return {
        shouldApply,
        reason: shouldApply ? 'budget_elapsed' : 'throttled',
        elapsedMs,
        minimumIntervalMs: params.budget.minimumIntervalMs,
    };
}
