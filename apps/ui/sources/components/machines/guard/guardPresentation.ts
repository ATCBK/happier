import type { MachineGuardPolicyV1 } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import type { MachineGuardViewV1 } from '@happier-dev/protocol/machines/guard/guardRpcV1';
import type { GuardKeepReasonV1, MachineGuardLadderV1 } from '@happier-dev/protocol/machines/guard/guardViewV1';

import { formatMachineCountdown, formatMachineDuration } from '@/components/machines/durationWords';
import { parsePolicyDuration } from '@/components/machines/policy/policyDuration';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { getPreferredLanguage, t } from '@/text';
import { joinList } from '@/utils/text/joinList';

import type { GuardRowId } from './useGuardPolicy';

/**
 * The Guard tab's words (plan 50 §13, lab `rg`): what each rule says in its current state, what the
 * ladder would do, and the choices each rule offers (R43: continuous values end with Custom…). The
 * rules are the machine's one resources policy; the ladder and lists are the daemon's view. Nothing
 * here decides what is stopped.
 */

export type GuardRung = MachineGuardLadderV1['steps'][number]['rung'];
export type GuardLadderStep = MachineGuardLadderV1['steps'][number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "2 min", "1 h", "2 h 30 min", "1 d": every Guard duration in the one machine duration wording. */
export const formatGuardDuration = formatMachineDuration;

export const MEMORY_SUSTAIN_PRESETS_MS = [1, 2, 5, 10].map(minutes => minutes * MINUTE);
export const MEMORY_COOLDOWN_PRESETS_MS = [1, 2, 5].map(minutes => minutes * MINUTE);
export const IDLE_AFTER_PRESETS_MS = [30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR];
export const IDLE_LEAD_PRESETS_MS = [1, 5, 10].map(minutes => minutes * MINUTE);
export const LEFT_BEHIND_GRACE_PRESETS_MS = [0, 30_000, 2 * MINUTE, 10 * MINUTE];
export const CEILING_PRESET_BYTES = [2, 4, 8, 16, 32].map(gib => gib * 1024 ** 3);
export const CEILING_WARN_PRESETS = [80, 90, 95];
export const PAUSE_FOR_MS = HOUR;

/** An explicit duration in milliseconds, in whole minutes from one up. */
export function parseCustomGuardMinutes(raw: string): number | null {
    return parsePolicyDuration(raw, { unit: 'ms', minimum: MINUTE, step: MINUTE });
}

/** An explicit duration in milliseconds, in whole seconds from zero up. */
export function parseCustomGuardGrace(raw: string): number | null {
    return parsePolicyDuration(raw, { unit: 'ms', minimum: 0, step: 1000 });
}

/** "12 GB", "1.5 TB", "800 MB" → bytes in the memory base (a ceiling is memory). */
export function parseCustomCeilingBytes(raw: string): number | null {
    const match = /^\s*(\d+(?:[.,]\d+)?)\s*(mb|gb|tb)?\s*$/iu.exec(raw);
    if (!match) return null;
    const value = Number(match[1]!.replace(',', '.'));
    const scale = { mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[(match[2] ?? 'gb').toLowerCase() as 'mb' | 'gb' | 'tb'];
    const bytes = Math.round(value * scale);
    return bytes > 0 && Number.isSafeInteger(bytes) ? bytes : null;
}

/** A whole percent between 1 and 99 ("85", "85 %"). */
export function parseCustomWarnPercent(raw: string): number | null {
    const value = Number(raw.trim().replace(/\s*%$/u, ''));
    return Number.isInteger(value) && value >= 1 && value <= 99 ? value : null;
}

export function formatGuardGrace(ms: number): string {
    if (ms === 0) return t('machineGuard.leftBehind.atOnce');
    return ms < MINUTE ? t('machineGuard.leftBehind.seconds', { seconds: Math.round(ms / 1000) }) : formatGuardDuration(ms);
}

export function formatGuardCeiling(bytes: number | null): string {
    return bytes === null ? t('machineGuard.limits.ceilingNone') : formatMachineBytes(bytes, 'memory');
}

export function guardKeepReasonLabel(reason: GuardKeepReasonV1): string {
    return t(`machineGuard.reasons.${reason}`);
}

export function guardLevelWord(level: 'elevated' | 'critical'): string {
    return t(level === 'critical' ? 'machineGuard.memory.levelWordCritical' : 'machineGuard.memory.levelWordElevated');
}

/** "15:04": a clock time as the reader's language says it. */
export function formatGuardClock(at: number): string {
    return new Intl.DateTimeFormat(getPreferredLanguage(), { hour: '2-digit', minute: '2-digit' }).format(at);
}

export const formatGuardCountdown = formatMachineCountdown;

// ── Memory guard ─────────────────────────────────────────────────────────────────────────────────────

export type MemoryGuardRowState =
    | Readonly<{ kind: 'unavailable'; reason: 'no_pressure_signal' | 'sampler_unavailable' }>
    | Readonly<{ kind: 'off' }>
    | Readonly<{ kind: 'paused'; until: number }>
    | Readonly<{ kind: 'watching' }>
    /** On in the saved rules, and the machine hasn't said yet what it is doing. */
    | Readonly<{ kind: 'on_unread' }>
    | Readonly<{ kind: 'sustaining' }>
    | Readonly<{ kind: 'acting'; step: 1 | 2 | 3 }>
    | Readonly<{ kind: 'out_of_steps' }>;

/** What the memory guard is doing now, from the policy and the daemon's state (G1, G2, G8, G9). */
export function resolveMemoryGuardRowState(policy: MachineGuardPolicyV1, state: MachineGuardViewV1['state'], nowMs: number): MemoryGuardRowState {
    const pressure = state.capabilities.memoryPressure;
    if (pressure.status === 'unavailable') return { kind: 'unavailable', reason: pressure.reason };
    const guard = policy.memoryGuard;
    if (!guard.enabled) return { kind: 'off' };
    if (guard.pausedUntil !== null && guard.pausedUntil > nowMs) return { kind: 'paused', until: guard.pausedUntil };
    const episode = state.episode;
    if (!episode) return { kind: 'watching' };
    if (episode.state === 'sustaining') return { kind: 'sustaining' };
    if (episode.state === 'out_of_steps') return { kind: 'out_of_steps' };
    return { kind: 'acting', step: episode.step ?? 1 };
}

export function describeMemoryGuardRow(row: MemoryGuardRowState, policy: MachineGuardPolicyV1, machine: string): string {
    const sustain = formatGuardDuration(policy.memoryGuard.sustainMs);
    switch (row.kind) {
        case 'unavailable': return t(row.reason === 'no_pressure_signal' ? 'machineGuard.memory.noPressure' : 'machineGuard.memory.samplerUnavailable', { machine });
        case 'off': return t('machineGuard.memory.off');
        case 'paused': return t('machineGuard.memory.paused', { time: formatGuardClock(row.until) });
        case 'watching': return t('machineGuard.memory.watching', { level: guardLevelWord(policy.memoryGuard.actAt), sustain });
        case 'on_unread': return t('machineGuard.memory.onUnread', { level: guardLevelWord(policy.memoryGuard.actAt), sustain });
        case 'sustaining': return t('machineGuard.memory.sustaining', { sustain });
        case 'acting': return t('machineGuard.memory.acting', { step: row.step });
        case 'out_of_steps': return t('machineGuard.memory.outOfSteps');
    }
}

// ── The ladder ───────────────────────────────────────────────────────────────────────────────────────

export const GUARD_RUNGS: readonly GuardRung[] = ['browsers', 'devServers', 'idleSessions'];

export type GuardLadderTrailing =
    | Readonly<{ kind: 'frees'; bytes: number }>
    | Readonly<{ kind: 'nothing' }>
    | Readonly<{ kind: 'off' }>
    | Readonly<{ kind: 'checking' }>
    | Readonly<{ kind: 'done' }>;

/** A step's right-hand words: what it would free, that nothing is eligible, off, or where it is in an episode. */
export function describeLadderTrailing(step: GuardLadderStep): GuardLadderTrailing {
    if (!step.enabled || step.status === 'off') return { kind: 'off' };
    if (step.status === 'run') return { kind: 'checking' };
    if (step.status === 'done') return { kind: 'done' };
    if (step.candidates.length === 0) return { kind: 'nothing' };
    return { kind: 'frees', bytes: step.freesAboutBytes };
}

/** The step the guard would take first: the first enabled step with something to free. */
export function selectNextLadderRung(ladder: MachineGuardLadderV1): GuardRung | null {
    const marked = ladder.steps.find(step => step.status === 'next' || step.status === 'run');
    if (marked) return marked.rung;
    return ladder.steps.find(step => step.enabled && step.status !== 'off' && step.candidates.length > 0)?.rung ?? null;
}

/** "That is up to 5.5 GB of the 57 GB in use. The rest is 3 sessions at work, …, and 47 GB that isn't Happier's." */
export function describeLadderSummary(summary: MachineGuardLadderV1['summary']): Readonly<{ amount: string; of: string; rest: string | null }> {
    const parts = [
        ...(summary.workingSessions > 0 ? [t('machineGuard.ladder.restWorking', { count: summary.workingSessions })] : []),
        ...(summary.leftAloneSessions > 0 ? [t('machineGuard.ladder.restLeftAlone', { count: summary.leftAloneSessions })] : []),
        ...(summary.notHappiersBytes > 0 ? [t('machineGuard.ladder.restNotHappier', { amount: formatMachineBytes(summary.notHappiersBytes, 'memory') })] : []),
    ];
    return {
        amount: formatMachineBytes(summary.candidatesBytes, 'memory'),
        of: t('machineGuard.ladder.summaryOf', { inUse: formatMachineBytes(summary.inUseBytes, 'memory') }),
        rest: parts.length === 0 ? null : t('machineGuard.ladder.summaryRest', { parts: joinList(parts) }),
    };
}


// ── Idle sessions / terminals ────────────────────────────────────────────────────────────────────────

/** `idle` null: the machine hasn't answered, so the row says the rule only, never what is idle there now. */
export function describeIdleSessionsRow(policy: MachineGuardPolicyV1['idleSessions'], idle: MachineGuardViewV1['idle'] | null): string {
    if (policy.enabled) return t('machineGuard.idle.onHelp', { lead: formatGuardDuration(policy.warnBeforeMs) });
    if (idle === null) return t('machineGuard.idle.offUnread');
    const long = idle.filter(entry => entry.idleMs >= policy.afterMs).length;
    return long === 0 ? t('machineGuard.idle.offNone') : t('machineGuard.idle.offSome', { count: long, after: formatGuardDuration(policy.afterMs) });
}

/** Sessions that would stop come first, soonest first; then the kept; then the rest by how long they idled. */
export function orderIdleSessions(idle: MachineGuardViewV1['idle']): MachineGuardViewV1['idle'] {
    const rank = (entry: MachineGuardViewV1['idle'][number]) => entry.status === 'stops_at' ? 0 : entry.status === 'kept' ? 1 : 2;
    return idle.slice().sort((a, b) => rank(a) - rank(b) || (a.stopAt ?? 0) - (b.stopAt ?? 0) || b.idleMs - a.idleMs);
}

// ── Left behind ──────────────────────────────────────────────────────────────────────────────────────

/** `present` null: the machine hasn't answered, so an Off row says the rule only, never what runs there now. */
export function describeLeftBehindRow(policy: MachineGuardPolicyV1['leftBehind'], present: MachineGuardViewV1['leftBehind'] | null, machine: string): string {
    if (policy.mode === 'ask') return t('machineGuard.leftBehind.askHelp');
    if (policy.mode === 'automatic') {
        return policy.graceMs === 0 ? t('machineGuard.leftBehind.automaticAtOnceHelp')
            : t('machineGuard.leftBehind.automaticHelp', { grace: formatGuardGrace(policy.graceMs) });
    }
    if (present === null) return t('machineGuard.leftBehind.offUnread');
    if (present.count === 0) return t('machineGuard.leftBehind.offNone', { machine });
    return present.footprintBytes === null ? t('machineGuard.leftBehind.offSome', { count: present.count, machine })
        : t('machineGuard.leftBehind.offSomeBytes', { count: present.count, machine, amount: formatMachineBytes(present.footprintBytes, 'memory') });
}

// ── Limits and power ─────────────────────────────────────────────────────────────────────────────────

/** Why a ceiling is unavailable here, naming the OS the person knows ("macOS", "Windows") when it is one. */
export function describeCeilingUnavailable(reason: 'not_linux' | 'no_user_manager' | 'no_memory_controller', platform: string | undefined): string {
    if (reason === 'no_user_manager') return t('machineGuard.limits.ceilingNoUserManager');
    if (reason === 'no_memory_controller') return t('machineGuard.limits.ceilingNoMemoryController');
    // Operating-system names are proper nouns, not copy.
    const os = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : null;
    return os ? t('machineGuard.limits.ceilingNotLinux', { os }) : t('machineGuard.limits.ceilingNotLinuxGeneric');
}

// ── Saved versus running ─────────────────────────────────────────────────────────────────────────────

/** The policy value each row sets, to tell a saved value from the one the machine last said it runs. */
const ROW_VALUE: Readonly<Record<GuardRowId, (policy: MachineGuardPolicyV1) => unknown>> = {
    memory: policy => policy.memoryGuard.enabled,
    level: policy => policy.memoryGuard.actAt,
    sustain: policy => policy.memoryGuard.sustainMs,
    cooldown: policy => policy.memoryGuard.cooldownMs,
    steps: policy => `${policy.memoryGuard.steps.browsers}${policy.memoryGuard.steps.devServers}${policy.memoryGuard.steps.idleSessions}`,
    idle: policy => policy.idleSessions.enabled,
    idleAfter: policy => policy.idleSessions.afterMs,
    idleLead: policy => policy.idleSessions.warnBeforeMs,
    terminals: policy => policy.idleTerminals.enabled,
    terminalsAfter: policy => policy.idleTerminals.afterMs,
    terminalsLead: policy => policy.idleTerminals.warnBeforeMs,
    leftBehind: policy => policy.leftBehind.mode,
    grace: policy => policy.leftBehind.graceMs,
    ceiling: policy => policy.sessionMemoryCeiling.bytes,
    ceilingWarn: policy => policy.sessionMemoryCeiling.warnAtPercent,
    awake: policy => policy.keepAwake,
};

/**
 * True when a row's saved value is not what the machine's last answer says it runs (FX5 item 23): the controls
 * show the saved intent; only the machine's own view is evidence of execution. No answer yet is not a mismatch.
 */
export function guardRowAwaitsMachine(row: GuardRowId, saved: MachineGuardPolicyV1, running: MachineGuardPolicyV1 | null): boolean {
    return running !== null && ROW_VALUE[row](saved) !== ROW_VALUE[row](running);
}
