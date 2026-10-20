import * as React from 'react';
import { buildWorkBoardItemKeyV1, type BoardItemRefV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { getInstalledPluginUiClientExecutableComposition, resolvePluginUiClientWorkItemsRegistration } from '@/components/plugins/reactNative/clientExecutableContributions';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/projection';
import { readBoardTaskItems, type BoardTaskItems, type BoardTaskSource } from './boardTaskItems';

const EMPTY: BoardTaskItems = Object.freeze({ refs: [], linkedRefs: [], items: new Map(), complete: true });
const NO_SOURCES: Readonly<Record<string, BoardTaskSource>> = Object.freeze({});

/** Visit-local reads of the plugin's live owner, retired with the Account and exact registrations. */
export function useBoardTaskItems(serverId: string | null, refs: readonly BoardItemRefV1[],
    filtered: readonly BoardItemRefV1[] | null | undefined, enabled = true): BoardTaskItems {
    const projection = useAppShellPluginUiProjection();
    const platform = resolvePluginUiClientExecutablePlatform();
    const composition = getInstalledPluginUiClientExecutableComposition();
    const sources = projection.pluginUiProjection?.workItemsById ?? NO_SOURCES;
    const demanded = enabled && serverId !== null && (refs.some(ref => ref.kind === 'task')
        || filtered !== undefined && Object.keys(sources).length > 0);
    const subscribe = React.useCallback((listener: () => void) => demanded ? composition.subscribe(listener) : () => {}, [composition, demanded]);
    const revision = React.useSyncExternalStore(subscribe, composition.revision, composition.revision);
    const selectionKey = JSON.stringify([refs.filter(ref => ref.kind === 'task').map(buildWorkBoardItemKeyV1),
        (filtered ?? []).filter(ref => ref.kind === 'session').map(buildWorkBoardItemKeyV1)]);
    const accountLifetime = projection.accountLifetime;
    const unanswered = React.useMemo((): BoardTaskItems => {
        const picked = refs.filter(ref => ref.kind === 'task');
        const unavailable = !projection.interactionEnabled || !accountLifetime?.isCurrent();
        return { refs: picked, linkedRefs: [], items: unavailable ? new Map(picked.map(ref => [buildWorkBoardItemKeyV1(ref), null])) : EMPTY.items, complete: false };
    }, [selectionKey, projection.interactionEnabled, accountLifetime]);
    const [state, setState] = React.useState<Readonly<{ selectionKey: string; serverId: string | null;
        lifetime: typeof accountLifetime; sources: typeof sources; revision: number; value: BoardTaskItems }> | null>(null);
    React.useEffect(() => {
        if (!demanded || !serverId || !accountLifetime?.isCurrent() || !projection.interactionEnabled) return;
        const controller = new AbortController();
        const sessions = (filtered ?? []).flatMap(ref => ref.kind === 'session'
            && areServerProfileIdentifiersEquivalent(ref.qualifiedId.serverId, serverId)
            ? [{ serverId: ref.qualifiedId.serverId, sessionId: ref.qualifiedId.id }] : []);
        let reading = false;
        let again = false;
        let watchesComplete = true;
        const readableSources: BoardTaskSource[] = [];
        const refresh = async (): Promise<void> => {
            if (controller.signal.aborted || !accountLifetime.isCurrent()) return;
            if (reading) { again = true; return; }
            reading = true;
            try {
                const result = await readBoardTaskItems({ serverId, refs, sessions, sources: readableSources,
                    platform, signal: controller.signal });
                const value = watchesComplete ? result : { ...result, complete: false };
                if (!controller.signal.aborted && accountLifetime.isCurrent()) setState({ selectionKey, serverId,
                    lifetime: accountLifetime, sources, revision, value });
            } catch {
                if (!controller.signal.aborted && accountLifetime.isCurrent()) setState({ selectionKey, serverId,
                    lifetime: accountLifetime, sources, revision, value: { refs: refs.filter(ref => ref.kind === 'task'), linkedRefs: [],
                        items: EMPTY.items, complete: false } });
            } finally {
                reading = false;
                if (again && !controller.signal.aborted) { again = false; void refresh(); }
            }
        };
        const retirement = accountLifetime.onRetire(() => controller.abort());
        const stops: (() => void)[] = [];
        for (const source of Object.values(sources)) {
            const runtime = resolvePluginUiClientWorkItemsRegistration({ source, platform })?.runtime;
            const itemIds = refs.filter(ref => ref.kind === 'task' && ref.pluginId === source.pluginId
                && areServerProfileIdentifiersEquivalent(ref.qualifiedId.serverId, serverId)).map(ref => ref.qualifiedId.id);
            if (itemIds.length === 0 && sessions.length === 0) continue;
            try {
                if (runtime?.watch) stops.push(runtime.watch({ serverId, itemIds, sessionIds: sessions.map(session => session.sessionId) }, () => { void refresh(); }));
                readableSources.push(source);
            } catch { watchesComplete = false; }
        }
        void refresh();
        return () => {
            controller.abort();
            retirement.dispose();
            for (const stop of stops) stop();
        };
    }, [accountLifetime, demanded, projection.interactionEnabled, platform, revision, selectionKey, serverId, sources]);
    if (!demanded) return EMPTY;
    return state?.selectionKey === selectionKey && state.serverId === serverId && state.lifetime === accountLifetime
        && accountLifetime?.isCurrent() && state.sources === sources && state.revision === revision && projection.interactionEnabled
        ? state.value : unanswered;
}
