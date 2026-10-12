import { isMachineGuardRestorationWayBackV1, type MachineGuardActivityRowV1, type MachineGuardActivityWayBackV1 } from '@happier-dev/protocol/machines/guard/activityV1';

import type { IconName } from '@/components/ui/icons/iconRegistry.generated';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { t } from '@/text';

import { formatGuardClock, formatGuardDuration, guardLevelWord } from '../guardPresentation';

/**
 * One Activity receipt in words (lab `rg` G7, `RS.evt`): its icon, title, the bold figure (memory
 * freed, or bytes in Trash), the reason, its tone (a decision is open, or something failed) and the
 * ways back. The receipt is the daemon's; nothing here re-derives what happened.
 */

export type GuardActivityTone = 'plain' | 'attention' | 'danger';

export type GuardActivityRowModel = Readonly<{
    id: string;
    at: number;
    icon: IconName;
    title: string;
    /** The bold amount: memory freed, or bytes now in Trash. */
    figure: string | null;
    reason: string | null;
    tone: GuardActivityTone;
    undone: boolean;
    wayBack: readonly MachineGuardActivityWayBackV1[];
}>;

function subjectTitle(entry: MachineGuardActivityRowV1): string {
    const subject = entry.subject;
    if (!subject) return t('machineGuard.activity.kinds.something');
    switch (subject.kind) {
        case 'session': return subject.title;
        case 'service': return subject.label;
        case 'terminal': return subject.label;
        default: return t('machineGuard.activity.kinds.something');
    }
}

function title(entry: MachineGuardActivityRowV1): string {
    const subject = entry.subject;
    switch (entry.kind) {
        case 'stopped_session':
            return t('machineGuard.activity.kinds.stoppedSession', { title: subjectTitle(entry) });
        case 'closed_browser': return t('machineGuard.activity.kinds.closedBrowser');
        case 'stopped_service': return t('machineGuard.activity.kinds.stoppedService', { label: subjectTitle(entry) });
        case 'stopped_left_behind':
            return t('machineGuard.activity.kinds.stoppedLeftBehind', { count: subject?.kind === 'processes' ? subject.count : 1 });
        case 'out_of_steps': return t('machineGuard.activity.kinds.outOfSteps');
        case 'stop_failed': return t('machineGuard.activity.kinds.stopFailed', { label: subjectTitle(entry) });
        case 'kept_running': return t('machineGuard.activity.kinds.keptRunning', { title: subjectTitle(entry) });
        case 'ceiling_near': return t('machineGuard.activity.kinds.ceilingNear', { title: subjectTitle(entry) });
        case 'ceiling_reached': return t('machineGuard.activity.kinds.ceilingReached', { title: subjectTitle(entry) });
        case 'system_oom_kill': return t('machineGuard.activity.kinds.systemOomKill');
        case 'trash_moved': return t('machineGuard.activity.kinds.trashMoved', { count: subject?.kind === 'trash' ? subject.items : 1 });
        case 'trash_emptied': return t('machineGuard.activity.kinds.trashEmptied');
        case 'closed_terminal':
            return t('machineGuard.activity.kinds.closedTerminal', { label: subjectTitle(entry),
                duration: formatGuardDuration(subject?.kind === 'terminal' ? subject.idleMs : 0) });
        case 'housekeeping': return t('machineGuard.activity.kinds.housekeeping');
        case 'start_failed': return t('machineGuard.activity.kinds.startFailed', { label: subjectTitle(entry) });
        case 'undone': return t('machineGuard.activity.kinds.undone');
    }
}

const ICONS: Readonly<Record<MachineGuardActivityRowV1['kind'], IconName>> = {
    stopped_session: 'moon', closed_browser: 'globe', stopped_service: 'stop', stopped_left_behind: 'tree-structure',
    out_of_steps: 'warning-circle', stop_failed: 'x-circle', kept_running: 'check', ceiling_near: 'speedometer',
    ceiling_reached: 'speedometer', system_oom_kill: 'x-circle', trash_moved: 'trash', trash_emptied: 'trash',
    closed_terminal: 'terminal', housekeeping: 'archive', start_failed: 'x-circle', undone: 'arrow-arc-left',
};

function reason(entry: MachineGuardActivityRowV1): string | null {
    if (entry.undoneAt !== undefined) return t('machineGuard.activity.undoneAt', { time: formatGuardClock(entry.undoneAt) });
    const parts: string[] = [];
    if (entry.note) parts.push(entry.note);
    else if (entry.kind === 'kept_running') parts.push(t('machineGuard.activity.because.kept_running'));
    else if (entry.rule === 'memory_guard' && entry.trigger) {
        parts.push(t('machineGuard.activity.trigger', { level: guardLevelWord(entry.trigger.level), duration: formatGuardDuration(entry.trigger.sinceMs) }));
        if (entry.step) parts.push(t('machineGuard.activity.stepN', { step: entry.step }));
    } else if (entry.rule === 'idle_sessions' || entry.rule === 'left_behind' || entry.rule === 'ceiling'
        || entry.rule === 'approved_proposal' || entry.rule === 'idle_terminals') {
        parts.push(t(`machineGuard.activity.because.${entry.rule}`));
    }
    if (entry.outcome === 'did_not_help') parts.push(t('machineGuard.activity.didNotHelp'));
    return parts.length > 0 ? parts.join(' · ') : null;
}

function figure(entry: MachineGuardActivityRowV1): string | null {
    if (entry.freedBytes !== undefined && entry.freedBytes > 0) {
        // Trash and disk figures are storage; everything the guard stops frees memory.
        const kind = entry.kind === 'trash_emptied' ? 'storage' : 'memory';
        return t('machineGuard.activity.freed', { amount: formatMachineBytes(entry.freedBytes, kind) });
    }
    if (entry.inTrashBytes !== undefined && entry.inTrashBytes > 0) return t('machineGuard.activity.inTrash', { amount: formatMachineBytes(entry.inTrashBytes, 'storage') });
    return null;
}

function tone(entry: MachineGuardActivityRowV1): GuardActivityTone {
    if (entry.outcome === 'failed' || entry.kind === 'stop_failed' || entry.kind === 'start_failed' || entry.kind === 'system_oom_kill') return 'danger';
    if (entry.outcome === 'did_not_help' || entry.kind === 'out_of_steps' || entry.kind === 'ceiling_reached') return 'attention';
    return 'plain';
}

export function describeGuardActivityRow(entry: MachineGuardActivityRowV1): GuardActivityRowModel {
    const undone = entry.undoneAt !== undefined;
    return {
        id: entry.id, at: entry.at, icon: ICONS[entry.kind], title: title(entry), figure: undone ? null : figure(entry),
        reason: reason(entry), tone: undone ? 'plain' : tone(entry), undone,
        // An undone receipt has no way back left to take.
        wayBack: undone ? [] : entry.wayBack ?? [],
    };
}

export function guardWayBackLabel(item: MachineGuardActivityWayBackV1): string {
    return t(`machineGuard.activity.wayBack.${item.label}`);
}

/** A restoration (Resume, Start again, Reopen, Undo) goes back through the receipt's Undo; others run their own Action. */
export const isGuardRestoration = isMachineGuardRestorationWayBackV1;

/** Calendar-day groups, newest first, with what each day freed (lab G7 "Today 14.0 GB of memory freed · 6.4 GB in Trash"). */
export function groupGuardActivityByDay(entries: readonly MachineGuardActivityRowV1[]): readonly Readonly<{
    dayStart: number;
    entries: readonly MachineGuardActivityRowV1[];
    freedMemoryBytes: number;
    inTrashBytes: number;
}>[] {
    const startOf = (at: number) => { const date = new Date(at); date.setHours(0, 0, 0, 0); return date.getTime(); };
    const groups = new Map<number, MachineGuardActivityRowV1[]>();
    for (const entry of entries.slice().sort((a, b) => b.at - a.at)) {
        const day = startOf(entry.at);
        groups.set(day, [...(groups.get(day) ?? []), entry]);
    }
    return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([dayStart, dayEntries]) => ({
        dayStart, entries: dayEntries,
        freedMemoryBytes: dayEntries.reduce((sum, entry) => sum + (entry.undoneAt === undefined && entry.kind !== 'trash_emptied' ? entry.freedBytes ?? 0 : 0), 0),
        inTrashBytes: dayEntries.reduce((sum, entry) => sum + (entry.undoneAt === undefined ? entry.inTrashBytes ?? 0 : 0), 0),
    }));
}
