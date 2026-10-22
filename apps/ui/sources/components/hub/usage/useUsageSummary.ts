import * as React from 'react';

import {
    useConnectedServiceQuotaSummaries,
    type ConnectedServiceAccountWithoutUsage,
    type ConnectedServiceQuotaSummary,
} from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';

import type { UsageAccountInput } from './usageByProvider';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import {
    loadUsageSummaryWarmCache,
    saveUsageSummaryWarmCache,
    type UsageSummaryCacheV1,
} from '@/sync/domains/state/warmCachePersistence';

export type UsageSummaryEntry = UsageSummaryCacheV1['entries'][number];

export type UsageSummary = Readonly<{
    entries: readonly UsageSummaryEntry[];
    /**
     * Every connected account for a per-provider reading (`groupUsageByProvider`): the shown
     * entries, plus, from this launch's read, the accounts still being read or with nothing to show.
     */
    accounts: readonly UsageAccountInput[];
    /** When the shown values were read (epoch ms); `null` when nothing is known. */
    asOf: number | null;
    /** `live`: read in this launch; `lastKnown`: the device's saved value; `none`: nothing yet. */
    source: 'live' | 'lastKnown' | 'none';
}>;

const NOTHING: UsageSummary = Object.freeze({ entries: [], accounts: [], asOf: null, source: 'none' });

function toAccount(entry: UsageSummaryEntry): UsageAccountInput {
    return {
        key: entry.key,
        // A value saved before providers were grouped carries only its service's name.
        serviceGroupKey: entry.serviceGroupKey ?? entry.serviceLabel,
        serviceLabel: entry.serviceLabel,
        legacyServiceId: entry.legacyServiceId ?? null,
        accountLabel: entry.accountLabel ?? entry.profileLabel ?? null,
        accountEmail: entry.accountEmail ?? null,
        accountId: entry.accountId ?? null,
        planLabel: entry.planLabel,
        fetchedAt: entry.fetchedAt ?? null,
        state: 'ready',
        meters: entry.meters,
    };
}

/** This launch's read as the value the device keeps, or null when nothing was read. */
export function buildUsageSummaryCache(summaries: readonly ConnectedServiceQuotaSummary[]): UsageSummaryCacheV1 | null {
    if (summaries.length === 0) return null;
    return {
        v: 1,
        entries: summaries.map((summary) => ({
            key: summary.key,
            fetchedAt: summary.fetchedAt,
            serviceLabel: summary.serviceLabel,
            serviceGroupKey: summary.serviceGroupKey,
            legacyServiceId: summary.legacyServiceId,
            ...(summary.accountLabel !== null ? { accountLabel: summary.accountLabel } : {}),
            accountEmail: summary.accountEmail,
            accountId: summary.accountId,
            profileLabel: summary.profileLabel,
            planLabel: summary.planLabel,
            meters: summary.meters.map((meter) => ({
                meterId: meter.meterId,
                label: meter.label,
                remainingPct: meter.remainingPct,
                resetsAt: meter.resetsAt,
            })),
        })),
    };
}

/** What to show: this launch's read, else the device's saved value, plus the accounts without usage. */
export function buildUsageSummary(input: Readonly<{
    live: UsageSummaryCacheV1 | null;
    saved: UsageSummaryCacheV1 | null;
    accountsWithoutUsage: readonly ConnectedServiceAccountWithoutUsage[];
}>): UsageSummary {
    const pending = input.accountsWithoutUsage.map((account): UsageAccountInput => ({
        key: account.key,
        serviceGroupKey: account.serviceGroupKey,
        serviceLabel: account.serviceLabel,
        legacyServiceId: account.legacyServiceId,
        accountLabel: account.accountLabel,
        accountEmail: account.accountEmail,
        accountId: account.accountId,
        planLabel: null,
        fetchedAt: null,
        state: account.state,
        meters: [],
    }));
    const shown = input.live ?? input.saved;
    if (!shown && pending.length === 0) return NOTHING;
    return {
        entries: shown?.entries ?? [],
        accounts: [...(shown?.entries ?? []).map(toAccount), ...pending],
        asOf: shown && shown.entries.length > 0 && shown.entries.every((entry) => entry.fetchedAt != null)
            ? Math.min(...shown.entries.map((entry) => entry.fetchedAt!))
            : null,
        source: input.live ? 'live' : input.saved ? 'lastKnown' : 'none',
    };
}

/**
 * The Account's usage windows (each connected account's quota meters), for the hubs and the
 * sidebar Usage popover. It shows what this launch read, else the last value this device saved with
 * its time, and saves each new read. `load: 'visible'` retains the shared quota observation while
 * the surface is open, revalidating retained data on return. `load: 'cache'` never starts a read.
 * Reads keep the quota owner's exact Account/ref admission; explicit provider refresh stays separate.
 */
export function useUsageSummary(options: Readonly<{ load: 'visible' | 'cache' }>): UsageSummary {
    const { summaries, accountsWithoutUsage } = useConnectedServiceQuotaSummaries({
        fetchPolicy: options.load === 'visible' ? 'poll' : 'cache_only',
    });
    const scope = useActiveServerAccountScope();
    const serverId = scope?.serverId ?? null;
    const accountId = scope?.accountId ?? null;

    const live = React.useMemo(() => buildUsageSummaryCache(summaries), [summaries]);

    React.useEffect(() => {
        if (live && serverId && accountId) saveUsageSummaryWarmCache(serverId, accountId, live);
    }, [accountId, live, serverId]);

    const saved = React.useMemo(
        () => (serverId && accountId ? loadUsageSummaryWarmCache(serverId, accountId) : null),
        [accountId, serverId],
    );

    return React.useMemo(
        () => buildUsageSummary({ live, saved, accountsWithoutUsage }),
        [accountsWithoutUsage, live, saved],
    );
}
