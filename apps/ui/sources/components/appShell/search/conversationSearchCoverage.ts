import type { ConversationSearchMachineStatus, ConversationSearchResult } from '@/sync/domains/search/searchConversations';
import { t } from '@/text';

type CoverageGap = Exclude<ConversationSearchMachineStatus['status'], 'ok'>;

/** Most blocking first: a machine that cannot answer at all, then one that answered in part. */
const GAP_ORDER: readonly CoverageGap[] = ['offline', 'outdated', 'disabled-by-settings', 'partial'];

function describeGap(gap: CoverageGap, machines: string): string {
    switch (gap) {
        case 'offline': return t('conversationSearch.coverageOffline', { machines });
        case 'outdated': return t('conversationSearch.coverageOutdated', { machines });
        case 'disabled-by-settings': return t('conversationSearch.coverageDisabled', { machines });
        case 'partial': return t('conversationSearch.coveragePartial', { machines });
    }
}

/** Past this many machines their names stop helping (and often repeat), so the line counts them. */
const MACHINE_NAMES_MAX = 3;

/** Machines are counted by id: two machines may share a display name. */
function describeMachines(machineIds: readonly string[], machineName: (machineId: string) => string): string {
    const names = machineIds.map(machineName);
    return machineIds.length <= MACHINE_NAMES_MAX && new Set(names).size === names.length
        ? names.join(', ')
        : t('conversationSearch.coverageMachineCount', { count: machineIds.length });
}

/**
 * The one quiet line saying which machines a conversation search did not fully cover, and why. Full
 * coverage says nothing. The palette, its scan results and History read it the same way, so a machine
 * that is offline is "offline" everywhere rather than "partial" in one place. Sources that failed are
 * one summary here; a surface with per-source Retry lists them itself.
 */
export function describeConversationSearchCoverage(input: Readonly<{
    machines: ConversationSearchResult['machines'];
    homeStatus?: ConversationSearchResult['homeStatus'];
    failures?: ConversationSearchResult['failures'];
    machineName: (machineId: string) => string;
    /** Gaps this surface does not report (a machine whose index is off, where the Home answers instead). */
    omit?: readonly CoverageGap[];
}>): string {
    const parts: string[] = [];
    if (input.homeStatus === 'unavailable') parts.push(t('conversationSearch.coverageHomeUnavailable'));
    for (const gap of GAP_ORDER) {
        if (input.omit?.includes(gap)) continue;
        const machineIds = [...new Set(input.machines.filter((machine) => machine.status === gap
            && !(gap === 'partial' && input.failures?.some(failure => failure.machineId === machine.machineId))).map((machine) => machine.machineId))];
        if (machineIds.length > 0) parts.push(describeGap(gap, describeMachines(machineIds, input.machineName)));
    }
    if (input.failures?.length) parts.push(t('conversationSearch.coverageSourcesFailed'));
    return parts.join(' · ');
}
