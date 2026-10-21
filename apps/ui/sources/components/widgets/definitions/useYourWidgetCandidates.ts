import * as React from 'react';
import type { WidgetDefinitionSummaryV1 } from '@happier-dev/protocol/widgets';

import { describeWidgetDefinitionSummaryV1, readWidgetDescriptor, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { t } from '@/text';

import { runWidgetDefinitionCommand } from './widgetDefinitionCommands';

type Account = Readonly<{ serverId: string; accountId: string }>;

/**
 * Where a definition's data comes from, in the person's words: the plugin that serves its read
 * ("analytics replica"), else simply "Your widget". Never a Resource id.
 */
export function describeYourWidgetSource(candidate: WidgetCandidate, projection: PluginUiProjectionModel | null | undefined): string {
    const names = new Set<string>();
    for (const resource of candidate.resources ?? []) {
        const name = projection?.installedPackagesById[resource.pluginId]?.displayName;
        if (name) names.add(name);
    }
    return names.size > 0 ? [...names].join(', ') : t('widgetDefinition.yourWidget');
}

/**
 * The Account's own widget definitions for the gallery's "Your widgets" (lab `dashboards` dbind G):
 * read through `widgets.definition.list` — the same Action an agent uses — only while the Add
 * is open, so a closed control reads nothing. Body reads belong to the demanded preview/mount.
 */
export function useYourWidgetCandidates(account: Account | null, projection: PluginUiProjectionModel | null | undefined): readonly WidgetCandidate[] {
    return useYourWidgetCandidatesState(account, projection).candidates;
}

/** Where an Account inventory read stands: it settles as ready or failed, it never stays loading. */
export type AccountInventoryStatus = 'loading' | 'ready' | 'failed';

/** The same candidates, with how the Account's definitions read went (a search can wait for them, a failure offers Retry). */
export function useYourWidgetCandidatesState(account: Account | null, projection: PluginUiProjectionModel | null | undefined): Readonly<{
    candidates: readonly WidgetCandidate[];
    status: AccountInventoryStatus;
    retry: () => void;
}> {
    // `definitions: null` is a refused read of that Account.
    const [inventory, setInventory] = React.useState<Readonly<{ serverId: string; accountId: string;
        definitions: readonly WidgetDefinitionSummaryV1[] | null }> | null>(null);
    const [reload, retry] = React.useReducer((value: number) => value + 1, 0);
    const serverId = account?.serverId;
    const accountId = account?.accountId;
    React.useEffect(() => {
        if (!serverId || !accountId) { setInventory(null); return; }
        const controller = new AbortController();
        const scope = { serverId, accountId };
        setInventory(null);
        void (async () => {
            const listed = await runWidgetDefinitionCommand('widgets.definition.list', { account: scope }, scope, controller.signal);
            if (controller.signal.aborted) return;
            setInventory({ ...scope, definitions: listed.kind === 'applied' ? listed.result.definitions : null });
        })();
        return () => controller.abort();
    }, [accountId, serverId, reload]);
    return React.useMemo(() => {
        if (!inventory || inventory.serverId !== serverId || inventory.accountId !== accountId)
            return { candidates: [], status: account ? 'loading' : 'ready', retry };
        if (!inventory.definitions) return { candidates: [], status: 'failed', retry };
        const candidates = inventory.definitions.map(summary => {
            const installed = summary.sourceDefinition ? readWidgetDescriptor(projection, summary.sourceDefinition) : null;
            const candidate = describeWidgetDefinitionSummaryV1(summary, installed);
            return { ...candidate, pluginName: installed?.pluginName ?? describeYourWidgetSource(candidate, projection) };
        });
        return { candidates, status: 'ready', retry };
    }, [inventory, serverId, accountId, account, projection]);
}
