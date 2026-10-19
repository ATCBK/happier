import { buildWorkBoardItemKeyV1, type BoardItemRefV1 } from '@happier-dev/protocol/boards/workBoardV1';
import type { PluginWorkItemV1 } from '@happier-dev/protocol/plugins/contributions/workItems';
import {
    resolvePluginUiClientWorkItemsRegistration,
    type PluginUiClientExecutableRegistrationReader,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type BoardTaskSource = Parameters<typeof resolvePluginUiClientWorkItemsRegistration>[0]['source'];
export type BoardTaskItems = Readonly<{
    refs: readonly BoardItemRefV1[];
    /** Only proven filter discoveries, never unrelated explicit picks. */
    linkedRefs: readonly BoardItemRefV1[];
    items: ReadonlyMap<string, PluginWorkItemV1 | null>;
    complete: boolean;
}>;

/** Resolves only demanded work through the existing current client registration; stores no task data. */
export async function readBoardTaskItems(input: Readonly<{
    serverId: string;
    refs: readonly BoardItemRefV1[];
    sessions: readonly Readonly<{ serverId: string; sessionId: string }>[];
    sources: readonly BoardTaskSource[];
    platform: Parameters<typeof resolvePluginUiClientWorkItemsRegistration>[0]['platform'];
    reader?: PluginUiClientExecutableRegistrationReader;
    signal: AbortSignal;
}>): Promise<BoardTaskItems> {
    const refs = new Map(input.refs.filter(ref => ref.kind === 'task').map(ref => [buildWorkBoardItemKeyV1(ref), ref]));
    const items = new Map<string, PluginWorkItemV1 | null>([...refs.keys()].map(key => [key, null]));
    const linkedRefs = new Map<string, BoardItemRefV1>();
    const sessionIds = [...new Set(input.sessions.filter(session => areServerProfileIdentifiersEquivalent(session.serverId, input.serverId))
        .map(session => session.sessionId))];
    const results = await Promise.all(input.sources.map(async source => {
        const selected = [...refs.values()].filter(ref => ref.kind === 'task' && ref.pluginId === source.pluginId
            && areServerProfileIdentifiersEquivalent(ref.qualifiedId.serverId, input.serverId));
        const result: { entries: [string, PluginWorkItemV1 | null][]; linked: Extract<BoardItemRefV1, { kind: 'task' }>[]; complete: boolean } = {
            entries: [], linked: [], complete: true,
        };
        if (selected.length === 0 && sessionIds.length === 0) return result;
        const registration = resolvePluginUiClientWorkItemsRegistration({ source, platform: input.platform, reader: input.reader });
        if (!registration) return { ...result, complete: false };
        try {
            const linked = sessionIds.length > 0 && registration.runtime.findLinked
                ? await registration.runtime.findLinked({ serverId: input.serverId, sessionIds }, { signal: input.signal }) : [];
            const ids = [...new Set([...selected.map(ref => ref.qualifiedId.id), ...linked])];
            if (ids.length === 0) return result;
            const resolved = await registration.runtime.resolve({ serverId: input.serverId, itemIds: ids }, { signal: input.signal });
            input.signal.throwIfAborted();
            for (const id of ids) {
                const item = resolved[id] ?? null;
                const explicit = selected.filter(ref => ref.qualifiedId.id === id);
                for (const ref of explicit) result.entries.push([buildWorkBoardItemKeyV1(ref), item]);
                // A source lookup discovers candidates; the same returned live link facts prove filter membership.
                if (!item || !linked.includes(id) || !item.linkedSessions.some(session =>
                    areServerProfileIdentifiersEquivalent(session.serverId, input.serverId) && sessionIds.includes(session.sessionId))) continue;
                const ref: Extract<BoardItemRefV1, { kind: 'task' }> = explicit[0] ?? { kind: 'task', pluginId: source.pluginId, qualifiedId: { serverId: input.serverId, id } };
                const key = buildWorkBoardItemKeyV1(ref);
                result.linked.push(ref);
                result.entries.push([key, item]);
            }
        } catch (error) {
            if (input.signal.aborted) throw error;
            return { ...result, entries: [], linked: [], complete: false };
        }
        return result;
    }));
    input.signal.throwIfAborted();
    // Source order, not network completion order, determines the Board's discovery order.
    for (const result of results) {
        for (const [key, item] of result.entries) items.set(key, item);
        for (const ref of result.linked) {
            const key = buildWorkBoardItemKeyV1(ref);
            refs.set(key, ref);
            linkedRefs.set(key, ref);
        }
    }
    return { refs: [...refs.values()], linkedRefs: [...linkedRefs.values()], items, complete: results.every(result => result.complete) };
}
