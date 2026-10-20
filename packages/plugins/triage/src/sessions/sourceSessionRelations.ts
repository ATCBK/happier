import type { TriageDataActionContext } from '../actions/dataContext.js';
import { isPluginError } from '@happier-dev/plugin-sdk';
import {
    TriageSourceLinkSessionResultV1Schema,
    TriageSourceReadSessionLinksResultV1Schema,
    type TriageEntryRefV1,
} from '@happier-dev/triage-protocol/v1';
import { indexTriageAdmittedSourcesV1 } from '../actions/listEntries.js';
import { TriageListInvocationErrorV1Schema } from '../actions/listEntriesProtocol.js';
import type { TriageReadSourceSessionLinksResultV1, TriageSourceSessionLinksLaneV1 } from '../actions/sessionLinksProtocol.js';
import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import { readActiveConfiguredSourceRows } from '../corpus/configuration/readConfiguredSourceRows.js';
import { configuredSourceInstanceIsOwnedBy } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { renderSourceQualifiedId, sameTriageEntryReference } from '../corpus/identity/components.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { linkEntryToSession, unlinkEntryFromSession, type TriageEntrySessionLinkDisplayV1 } from './entrySessionLinks.js';

export type TriageSourceSessionLinkV1 = Readonly<{
    entryRef: TriageEntryRefV1; sessionId: string; linkedAtMs: number; displayPath: string;
}>;
export type TriageSessionRelationWriteV1 = Readonly<{
    entryRef: TriageEntryRefV1; sessionId: string; sourceInstanceId?: string;
    display?: TriageEntrySessionLinkDisplayV1; linked: boolean;
}>;

/** One source-role decision for starts, explicit Actions, and mounted unlink. The
 * external relationship owner remains the fallback only when the role is absent. */
export function createTriageSourceSessionRelations(
    context: Pick<TriageDataActionContext, 'signal'> & Readonly<{
        services: Pick<TriageDataActionContext['services'], 'actions' | 'targetedContributions'>;
    }>,
    collections: Pick<CorpusCollectionsV1, 'sourceInstances' | 'sessionLinks'>,
) {
    const options = { signal: context.signal };
    async function current() {
        const observation = context.services.targetedContributions.observeForSelf(
            TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated: () => {} },
        );
        try {
            const snapshot = await observation.readCurrent(options);
            return indexTriageAdmittedSourcesV1(snapshot.contributions);
        } finally { observation.dispose(); }
    }
    // One invocation may link several attachments. Resolve its source/configured
    // view once; the host still validates each original operation handle at use.
    let view: Promise<Readonly<{
        sources: Awaited<ReturnType<typeof current>>;
        configured: Awaited<ReturnType<typeof readActiveConfiguredSourceRows>>;
    }>> | undefined;
    function readView() {
        return view ??= Promise.all([current(), readActiveConfiguredSourceRows(collections.sourceInstances, options)])
            .then(([sources, configured]) => ({ sources, configured }));
    }
    return {
        async write(input: TriageSessionRelationWriteV1): Promise<Readonly<{ status: 'linked' | 'unlinked' | 'conflict' | 'failed' }>> {
            try {
                const { sources, configured } = await readView();
                const source = sources.get(renderSourceQualifiedId(input.entryRef.source));
                if (source === undefined) return { status: 'failed' };
                const instances = configured.rows.filter((row) => configuredSourceInstanceIsOwnedBy(row, input.entryRef.source)
                    && (input.sourceInstanceId === undefined || row.configured.instance.sourceInstanceId === input.sourceInstanceId));
                const operation = source?.operations?.linkSession;
                if (operation !== undefined) {
                    if (instances.length !== 1 || !source?.descriptor.kinds.some((kind) => kind.id === input.entryRef.kindId)) return { status: 'failed' };
                    const entry = input.entryRef;
                    const result = TriageSourceLinkSessionResultV1Schema.parse(await context.services.actions.executeAdmittedTargetedOperation(operation, {
                        v: 1, instance: instances[0]!.configured,
                        localRef: { kindId: entry.kindId, collisionScope: entry.collisionScope, entryId: entry.entryId },
                        sessionId: input.sessionId, linked: input.linked,
                    }, options));
                    if (result.status !== (input.linked ? 'linked' : 'unlinked')) return { status: 'failed' };
                    // A previously persisted duplicate is removed explicitly through
                    // its relation owner after the authoritative source commit.
                    const reconciled = await unlinkEntryFromSession({ collections, entryRef: input.entryRef, sessionId: input.sessionId, signal: context.signal });
                    return reconciled.status === 'unlinked' ? result : { status: 'failed' };
                }
                if (source.operations?.readSessionLinks !== undefined) return { status: 'failed' };
                if (!input.linked) return await unlinkEntryFromSession({ collections, entryRef: input.entryRef, sessionId: input.sessionId, signal: context.signal });
                if (input.display === undefined) return { status: 'failed' };
                return await linkEntryToSession({ collections, entryRef: input.entryRef, sessionId: input.sessionId,
                    display: input.display, nowMs: Date.now(), signal: context.signal });
            } catch { return { status: 'failed' }; }
        },
        async read(input: Readonly<{ entryRef?: TriageEntryRefV1; sourceInstanceId?: string; sessionId?: string }>): Promise<
            TriageReadSourceSessionLinksResultV1 & Readonly<{ sourceOwned: boolean }>
        > {
            const { sources, configured } = await readView();
            const links: TriageSourceSessionLinkV1[] = [];
            const lanes: TriageSourceSessionLinksLaneV1[] = [];
            let sourceOwned = false;
            for (const row of configured.rows) {
                if (input.sourceInstanceId !== undefined && row.configured.instance.sourceInstanceId !== input.sourceInstanceId) continue;
                if (input.entryRef !== undefined && !configuredSourceInstanceIsOwnedBy(row, input.entryRef.source)) continue;
                const source = sources.get(row.sourceQualifiedId);
                const lane = { source: row.configured.instance.source, sourceInstanceId: row.configured.instance.sourceInstanceId,
                    displayLabel: row.configured.locator?.displayLabel ?? source?.descriptor.displayName ?? row.sourceQualifiedId };
                if (row.sourceQualifiedId !== renderSourceQualifiedId(row.configured.instance.source)) {
                    lanes.push({ ...lane, health: { kind: 'failed', failure: { class: 'unsupportedContract', code: 'sourceIdentityMismatch' } } });
                    sourceOwned = true;
                    continue;
                }
                if (source === undefined) { lanes.push({ ...lane, health: { kind: 'unavailable' } }); sourceOwned = true; continue; }
                const operation = source?.operations?.readSessionLinks;
                if (operation === undefined) {
                    if (source.operations?.linkSession !== undefined) {
                        lanes.push({ ...lane, health: { kind: 'failed', failure: { class: 'unsupportedContract', code: 'sessionLinksReadUnsupported' } } });
                        sourceOwned = true;
                    } else {
                        // No source relation roles: the Account Collection is
                        // the authoritative reader, not a missing source API.
                        lanes.push({ ...lane, health: { kind: 'complete' } });
                    }
                    continue;
                }
                sourceOwned = true;
                try {
                    const entry = input.entryRef;
                    const parsed = TriageSourceReadSessionLinksResultV1Schema.safeParse(await context.services.actions.executeAdmittedTargetedOperation(operation, {
                        v: 1, instance: row.configured,
                        ...(entry === undefined ? {} : { localRef: { kindId: entry.kindId, collisionScope: entry.collisionScope, entryId: entry.entryId } }),
                        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
                    }, options));
                    if (!parsed.success) {
                        lanes.push({ ...lane, health: { kind: 'failed', failure: { class: 'unsupportedContract', code: 'sessionLinksInvalidResult' } } });
                        continue;
                    }
                    const result = parsed.data;
                    if (result.kind !== 'complete') { lanes.push({ ...lane, health: result }); continue; }
                    if (result.links.some((link) => {
                        const entryRef = { source: row.configured.instance.source, ...link.localRef };
                        return !source.descriptor.kinds.some((kind) => kind.id === entryRef.kindId)
                            || (entry !== undefined && !sameTriageEntryReference(entry, entryRef))
                            || (input.sessionId !== undefined && input.sessionId !== link.sessionId);
                    })) {
                        lanes.push({ ...lane, health: { kind: 'failed', failure: { class: 'unsupportedContract', code: 'sessionLinksInvalidResult' } } });
                        continue;
                    }
                    lanes.push({ ...lane, health: { kind: 'complete' } });
                    for (const link of result.links) {
                        const entryRef = { source: row.configured.instance.source, ...link.localRef };
                        if (!links.some((existing) => existing.sessionId === link.sessionId && sameTriageEntryReference(existing.entryRef, entryRef))) {
                            links.push({ entryRef, sessionId: link.sessionId, linkedAtMs: link.linkedAtMs, displayPath: link.displayPath });
                        }
                    }
                } catch (error) {
                    const diagnostic = isPluginError(error) ? TriageListInvocationErrorV1Schema.safeParse({ code: error.code, retryable: error.retryable }) : null;
                    lanes.push({ ...lane, health: { kind: 'failed', failure: { class: 'transient', code: 'sessionLinksReadFailed' },
                        ...(diagnostic?.success ? { invocationError: diagnostic.data } : {}),
                    } });
                }
            }
            const complete = lanes.filter((lane) => lane.health.kind === 'complete').length;
            return { kind: complete === lanes.length ? 'complete' : complete > 0 ? 'partial' : 'failed', links, lanes, sourceOwned };
        },
    };
}
