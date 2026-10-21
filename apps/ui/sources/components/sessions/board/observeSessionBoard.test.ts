import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { describe, expect, it } from 'vitest';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createSessionSystemRecordRepository } from '@/sync/domains/sessionSystemRecords/repository';
import { observeSessionBoard, type SessionBoardBinding, type SessionBoardAuthority } from './observeSessionBoard';
import { resolveSessionBoardExecutableCurrentness } from '@/sync/domains/session/board/sessionBoardExecutableCurrentness';
import { resolveSessionBoardRetainedFreshness } from '@/sync/domains/session/board/sessionBoardProjection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';

const scope = { serverId: 'home-a', accountId: 'alice' };
const session = { serverId: scope.serverId, sessionId: 'session-one' };
const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const item = { v: 1, title: 'Note', frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Hello' } } } } as const;
const hostedItem = {
    v: 1,
    title: 'Interactive view',
    frame: 'card',
    height: { mode: 'auto', fallback: 'regular' },
    source: { kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<main>Hello</main>') },
} as const;
function record(localId: string, kind: string, value: unknown) {
    return { id: localId, address: { owner: 'host', namespace: 'surface', kind, localId }, content: { t: 'plain', v: value }, revision, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' };
}
const layout = record('layout', 'layout.v1', { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'full' }] }] });
const authority: SessionBoardAuthority = { contentContext: { mode: 'plain' }, capabilities: { readTranscript: true, editSessionRecords: true } };

describe('Board repository binding', () => {
    it('does not inventory Session content before a Board consumer demands it', async () => {
        const requests: string[] = [];
        const repository = createSessionSystemRecordRepository({ scope, request: async path => {
            requests.push(path);
            return Response.json({ records: [layout, record('note', 'item.v1', item)], nextCursor: null, hasNext: false });
        } });
        const stop = observeSessionBoard({ session, repository, demanded: false, authority,
            readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext,
            renewAuthority: async () => ({ status: 'ok', value: authority }), isCurrent: () => true, onChange: () => {},
        });
        await flushHookEffects({ cycles: 10 });
        expect(requests).toEqual([]);
        stop();
    });
    it('normalizes additive stored fields while isolating invalid required fields and unknown sources', async () => {
        const widget = { ...item, source: { kind: 'widget', instance: {
            v: 1, id: 'widget', definition: { kind: 'installed', surface: { pluginId: 'acme.widgets', localId: 'status' } },
            bindings: { session: { kind: 'context', slot: 'session' } },
        } } };
        const snapshot = { ...item, source: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Frozen' } } },
            snapshot: { asOf: '2026-09-05T00:00:00.000Z', provenance: [{ label: 'Status' }] } };
        const storedWidget = { ...widget, extra: true, height: { ...widget.height, extra: true }, source: {
            ...widget.source, extra: true, instance: { ...widget.source.instance, extra: true,
                definition: { ...widget.source.instance.definition, extra: true, surface: { ...widget.source.instance.definition.surface, extra: true } },
                bindings: { session: { ...widget.source.instance.bindings.session, extra: true } },
            },
        } };
        const storedSnapshot = { ...snapshot, source: { ...snapshot.source, extra: true, document: { ...snapshot.source.document,
            extra: true, root: { ...snapshot.source.document.root, extra: true } } },
            snapshot: { ...snapshot.snapshot, extra: true, provenance: [{ label: 'Status', extra: true }] } };
        const savedLayout = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'widget', width: 'full' }] }] };
        const repository = createSessionSystemRecordRepository({ scope, request: async () => new Response(JSON.stringify({
            records: [record('layout', 'layout.v1', { ...savedLayout, extra: true, tabs: [{ ...savedLayout.tabs[0], extra: true,
                items: [{ ...savedLayout.tabs[0].items[0], extra: true }] }] }),
                record('widget', 'item.v1', storedWidget), record('snapshot', 'item.v1', storedSnapshot),
                record('invalid', 'item.v1', { ...item, height: { mode: 'fixed' } }),
                record('unknown', 'item.v1', { ...item, source: { kind: 'unknown' } })], nextCursor: null, hasNext: false,
        })) });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({ session, repository, authority, readCapabilities: () => authority.capabilities,
            readContentContext: () => authority.contentContext, renewAuthority: async () => ({ status: 'ok', value: authority }),
            isCurrent: () => true, onChange: value => { latest = value; } });
        try {
            await flushHookEffects({ cycles: 50 });
            if (latest?.status !== 'ready') throw new Error('Board not ready');
            expect(latest.snapshot.layoutState.kind).toBe('ready');
            expect(latest.snapshot.itemsById.get('widget')?.state).toEqual({ kind: 'ready', item: { ...widget, destination: 'board' } });
            expect(latest.snapshot.itemsById.get('snapshot')?.state).toEqual({ kind: 'ready', item: { ...snapshot, destination: 'board' } });
            expect(latest.snapshot.itemsById.get('invalid')?.state.kind).toBe('unopenable');
            expect(latest.snapshot.itemsById.get('unknown')?.state.kind).toBe('unopenable');
        } finally { stop(); }
    });
    it('opens paged records, isolates malformed siblings, preserves offline content and retires denied access', async () => {
        let failure: 'offline' | 'forbidden' | null = null;
        const repository = createSessionSystemRecordRepository({ scope, request: async (path) => {
            if (failure === 'offline') throw new TypeError('offline');
            if (failure === 'forbidden') return new Response(JSON.stringify({ error: 'denied', code: 'plugin_session_record_forbidden' }), { status: 403 });
            const cursor = new URL(path, 'https://home-a').searchParams.get('cursor');
            return new Response(JSON.stringify(cursor ? { records: [record('broken', 'item.v1', {})], nextCursor: null, hasNext: false }
                : { records: [layout, record('note', 'item.v1', item)], nextCursor: 'next', hasNext: true }));
        } });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({ session, repository, authority, readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext, renewAuthority: async () => ({ status: 'ok', value: authority }), isCurrent: () => true, onChange: value => { latest = value; } });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { incomplete: false, layoutState: { kind: 'ready' } } });
        if (latest?.status !== 'ready') throw new Error('Board not ready');
        expect(latest.snapshot.itemsById.get('note')?.state.kind).toBe('ready');
        expect(latest.snapshot.itemsById.get('broken')?.state.kind).toBe('unopenable');
        const previous = latest.snapshot.itemsById.get('note');
        failure = 'offline'; repository.invalidate(session);
        await flushHookEffects({ cycles: 50 });
        // A thrown read is not evidence the Home is offline: the retained Board stays reachable.
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'stale', reachability: 'reachable', canEdit: true, capabilities: { editSessionRecords: true } } });
        expect(latest.snapshot.itemsById.get('note')).toBe(previous);
        failure = 'forbidden'; repository.invalidate(session);
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
        stop();
    });
    it('retires a previously ready executable Board when any required page reports the feature disabled', async () => {
        let featureDisabled = false;
        const hostedLayout = record('layout', 'layout.v1', {
            v: 1,
            tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'interactive', width: 'full' }] }],
        });
        const repository = createSessionSystemRecordRepository({ scope, request: async (path) => {
            const cursor = new URL(path, 'https://home-a').searchParams.get('cursor');
            if (featureDisabled && cursor === 'next') {
                return new Response(JSON.stringify({ error: 'disabled', code: 'plugin_session_record_feature_disabled' }), { status: 404 });
            }
            return new Response(JSON.stringify(cursor
                ? { records: [record('interactive', 'item.v1', hostedItem)], nextCursor: null, hasNext: false }
                : { records: [hostedLayout], nextCursor: 'next', hasNext: true }));
        } });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({
            session,
            repository,
            authority,
            readCapabilities: () => authority.capabilities,
            readContentContext: () => authority.contentContext,
            renewAuthority: async () => ({ status: 'ok', value: authority }),
            isCurrent: () => true,
            onChange: value => { latest = value; },
        });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { incomplete: false } });
        if (latest?.status !== 'ready') throw new Error('Board not ready');
        expect(latest.snapshot.itemsById.get('interactive')?.state.kind).toBe('ready');
        expect(latest.snapshot.views[0]?.placements[0]?.itemId).toBe('interactive');

        featureDisabled = true;
        repository.invalidate(session);
        await flushHookEffects({ cycles: 50 });

        expect(latest).toEqual({ status: 'unavailable', reason: 'board_feature_disabled' });
        expect(repository.getSnapshot(session, {
            type: 'list',
            namespace: 'surface',
            cursor: 'next',
        })).toMatchObject({
            data: { records: [{ address: { localId: 'interactive' } }] },
            freshness: 'stale',
            lastError: { status: 'feature_disabled' },
        });
        stop();
    });
    it('does not read under unknown access or another Home', async () => {
        let requests = 0;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => { requests++; return new Response('{}'); } });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({ session: { ...session, serverId: 'home-b' }, repository, authority, readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext,
            renewAuthority: async () => ({ status: 'ok', value: authority }), isCurrent: () => true, onChange: value => { latest = value; } });
        await flushHookEffects();
        expect(latest).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
        expect(requests).toBe(0); stop();
    });
});

describe('Board encryption and authority renewal', () => {
    it('keeps a background renewal quiet until the record reread settles, and reports a failed reread', async () => {
        const response = () => Response.json({ records: [layout, record('note', 'item.v1', item)], nextCursor: null, hasNext: false });
        let settleRead: ((value: Response) => void) | undefined;
        let refreshing = false;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => refreshing
            ? await new Promise<Response>(resolve => { settleRead = resolve; }) : response() });
        let settleAuthority: ((value: { status: 'ok'; value: SessionBoardAuthority }) => void) | undefined;
        const seen: SessionBoardBinding[] = [];
        const stop = observeSessionBoard({ session, repository, authority,
            readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext,
            renewAuthority: async () => await new Promise(resolve => { settleAuthority = resolve; }),
            isCurrent: () => true, onChange: value => { seen.push(value); } });
        try {
            await flushHookEffects({ cycles: 50 });
            expect(seen.at(-1)).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh', loading: 'idle' } });
            refreshing = true;
            seen.length = 0;
            repository.refreshObserved({ force: true });
            await flushHookEffects({ cycles: 10 });
            settleAuthority?.({ status: 'ok', value: authority });
            await flushHookEffects({ cycles: 20 });
            expect(seen.length).toBeGreaterThan(0);
            expect(seen.every(binding => binding.status === 'ready'
                && resolveSessionBoardRetainedFreshness(binding.snapshot) === null
                && binding.snapshot.loading === 'refreshing')).toBe(true);
            settleRead?.(new Response('{}', { status: 503 }));
            await flushHookEffects({ cycles: 30 });
            expect(seen.at(-1)).toMatchObject({ status: 'ready', snapshot: {
                freshness: 'stale', loading: 'idle', itemsById: expect.any(Map),
            } });
            const failed = seen.at(-1);
            if (failed?.status !== 'ready') throw new Error('Board lost its retained content');
            expect(resolveSessionBoardRetainedFreshness(failed.snapshot)).toBe('stale');
            expect(failed.snapshot.itemsById.get('note')?.state.kind).toBe('ready');
        } finally { stop(); }
    });

    it('keeps an unchanged widget admitted through a Board reread, but withdraws it on access loss', async () => {
        const widget = { ...item, source: { kind: 'widget', instance: {
            v: 1, id: 'counter', bindings: {},
            definition: { kind: 'installed', surface: { pluginId: 'acme.widgets', localId: 'counter' } },
        } } } as const;
        const response = () => Response.json({ records: [layout, record('counter', 'item.v1', widget)], nextCursor: null, hasNext: false });
        let settleRead: ((value: Response) => void) | undefined;
        let refreshing = false;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => refreshing
            ? await new Promise<Response>(resolve => { settleRead = resolve; }) : response() });
        let current = authority;
        let settleAuthority: ((value: { status: 'ok'; value: SessionBoardAuthority }) => void) | undefined;
        const seen: SessionBoardBinding[] = [];
        const stop = observeSessionBoard({ session, repository, authority,
            readCapabilities: () => current.capabilities, readContentContext: () => current.contentContext,
            renewAuthority: async () => await new Promise(resolve => { settleAuthority = resolve; }),
            isCurrent: () => true, onChange: value => { seen.push(value); } });
        try {
            await flushHookEffects({ cycles: 50 });
            const initial = seen.at(-1);
            if (initial?.status !== 'ready') throw new Error('Board not ready');
            const counter = initial.snapshot.itemsById.get('counter')!;
            const runtime = { phase: 'current' as const, interactionEnabled: true, pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION };
            expect(resolveSessionBoardExecutableCurrentness(initial.snapshot, counter, runtime)).toBe('current');
            refreshing = true;
            seen.length = 0;
            repository.invalidate(session);
            await flushHookEffects({ cycles: 10 });
            const pending = seen.at(-1);
            expect(pending).toMatchObject({ status: 'ready', snapshot: { freshness: 'stale', loading: 'refreshing' } });
            if (pending?.status !== 'ready') throw new Error('Board lost its retained content');
            expect(resolveSessionBoardRetainedFreshness(pending.snapshot)).toBeNull();
            expect(pending.snapshot.itemsById.get('counter')).toBe(counter);
            expect(seen.every(binding => binding.status === 'ready'
                && resolveSessionBoardExecutableCurrentness(binding.snapshot, counter, runtime) === 'current')).toBe(true);

            // A fresh record response can arrive before access renewal. Neither
            // event is permission to revive content after canonical access loss.
            settleRead?.(response());
            await flushHookEffects({ cycles: 10 });
            current = { ...authority, capabilities: { readTranscript: false, editSessionRecords: false } };
            repository.notifyContentContextChanged(session);
            await flushHookEffects({ cycles: 10 });
            expect(seen.at(-1)).toEqual({ status: 'unavailable', reason: 'forbidden' });
            settleAuthority?.({ status: 'ok', value: authority });
            await flushHookEffects({ cycles: 20 });
            expect(seen.at(-1)).toEqual({ status: 'unavailable', reason: 'forbidden' });
        } finally { stop(); }
    });

    it('keeps an installed widget running through a thrown Board read and recovers on the sync backoff', async () => {
        const widget = { ...item, source: { kind: 'widget', instance: {
            v: 1, id: 'counter', bindings: {},
            definition: { kind: 'installed', surface: { pluginId: 'acme.widgets', localId: 'counter' } },
        } } } as const;
        let failing = false;
        const repository = createSessionSystemRecordRepository({ scope, retryBackoff: { minDelayMs: 20, maxDelayMs: 40 }, request: async () => {
            if (failing) throw new TypeError('network unavailable');
            return Response.json({ records: [layout, record('counter', 'item.v1', widget)], nextCursor: null, hasNext: false });
        } });
        const seen: SessionBoardBinding[] = [];
        const stop = observeSessionBoard({ session, repository, authority, readCapabilities: () => authority.capabilities,
            readContentContext: () => authority.contentContext, renewAuthority: async () => ({ status: 'ok', value: authority }),
            isCurrent: () => true, onChange: value => { seen.push(value); } });
        try {
            await flushHookEffects({ cycles: 50 });
            const initial = seen.at(-1);
            if (initial?.status !== 'ready') throw new Error('Board not ready');
            const counter = initial.snapshot.itemsById.get('counter')!;
            const runtime = { phase: 'current' as const, interactionEnabled: true, pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION };
            failing = true;
            seen.length = 0;
            repository.invalidate(session);
            await flushHookEffects({ cycles: 30 });
            await new Promise(resolve => setTimeout(resolve, 100));
            await flushHookEffects({ cycles: 30 });
            expect(seen.length).toBeGreaterThan(0);
            expect(seen.every(binding => binding.status === 'ready' && binding.snapshot.reachability === 'reachable'
                && resolveSessionBoardExecutableCurrentness(binding.snapshot, counter, runtime) === 'current')).toBe(true);
            failing = false;
            await new Promise(resolve => setTimeout(resolve, 150));
            await flushHookEffects({ cycles: 30 });
            expect(seen.at(-1)).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh', loading: 'idle', reachability: 'reachable' } });
        } finally { stop(); }
    });

    it('does not republish retained Board content after a record denial while access renewal finishes', async () => {
        let settleRead: ((value: Response) => void) | undefined;
        let refreshing = false;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => refreshing
            ? await new Promise<Response>(resolve => { settleRead = resolve; })
            : Response.json({ records: [layout, record('note', 'item.v1', item)], nextCursor: null, hasNext: false }) });
        let settleAuthority: ((value: { status: 'ok'; value: SessionBoardAuthority }) => void) | undefined;
        const seen: SessionBoardBinding[] = [];
        const stop = observeSessionBoard({ session, repository, authority,
            readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext,
            renewAuthority: async () => await new Promise(resolve => { settleAuthority = resolve; }),
            isCurrent: () => true, onChange: value => { seen.push(value); } });
        try {
            await flushHookEffects({ cycles: 50 });
            expect(seen.at(-1)).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh' } });
            refreshing = true;
            repository.invalidate(session);
            await flushHookEffects({ cycles: 10 });
            settleRead?.(Response.json({ error: 'denied', code: 'plugin_session_record_forbidden' }, { status: 403 }));
            await flushHookEffects({ cycles: 10 });
            expect(seen.at(-1)).toEqual({ status: 'unavailable', reason: 'forbidden' });
            seen.length = 0;
            settleAuthority?.({ status: 'ok', value: authority });
            await flushHookEffects({ cycles: 30 });
            expect(seen.length).toBeGreaterThan(0);
            expect(seen.every(binding => binding.status === 'unavailable')).toBe(true);
        } finally { stop(); }
    });

    it('makes retained content inert as soon as canonical access is revoked, before renewal settles', async () => {
        const repository = createSessionSystemRecordRepository({ scope, request: async () => new Response(JSON.stringify({
            records: [layout, record('note', 'item.v1', item)],
            nextCursor: null,
            hasNext: false,
        })) });
        let current = authority;
        let settleRenewal: ((value: { status: 'ok'; value: SessionBoardAuthority }) => void) | undefined;
        let latest: SessionBoardBinding | undefined;
        const seen: SessionBoardBinding[] = [];
        const stop = observeSessionBoard({
            session,
            repository,
            authority,
            readCapabilities: () => current.capabilities,
            readContentContext: () => current.contentContext,
            renewAuthority: async () => await new Promise((resolve) => { settleRenewal = resolve; }),
            isCurrent: () => true,
            onChange: (value: SessionBoardBinding) => { latest = value; seen.push(value); },
        });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { layoutState: { kind: 'ready' } } });

        seen.length = 0;
        current = { ...authority, capabilities: { readTranscript: true, editSessionRecords: false } };
        repository.invalidate(session);
        await flushHookEffects({ cycles: 10 });

        expect(latest).toMatchObject({
            status: 'ready',
            snapshot: {
                canEdit: false,
                capabilities: { readTranscript: true, editSessionRecords: false },
            },
        });
        expect(seen.filter((binding): binding is Extract<SessionBoardBinding, { status: 'ready' }> => binding.status === 'ready')
            .every((binding) => binding.snapshot.canEdit === false)).toBe(true);

        current = { ...authority, capabilities: { readTranscript: false, editSessionRecords: false } };
        repository.notifyContentContextChanged(session);
        await flushHookEffects({ cycles: 10 });

        expect(latest).toEqual({ status: 'unavailable', reason: 'forbidden' });
        repository.notifyContentContextChanged(session);
        await flushHookEffects({ cycles: 10 });
        expect(latest).toEqual({ status: 'unavailable', reason: 'forbidden' });

        // Even a stale successful renewal result cannot overwrite the newer
        // canonical access projection that already revoked this viewer.
        settleRenewal?.({ status: 'ok', value: authority });
        await flushHookEffects({ cycles: 20 });
        expect(latest).toEqual({ status: 'unavailable', reason: 'forbidden' });
        repository.refreshObserved({ force: true });
        await flushHookEffects({ cycles: 20 });
        expect(latest).toEqual({ status: 'unavailable', reason: 'forbidden' });
        stop();
    });

    it('does not expose same-id content when the canonical Session projection belongs to another Home', async () => {
        let requests = 0;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            requests += 1;
            return new Response(JSON.stringify({ records: [layout], nextCursor: null, hasNext: false }));
        } });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({
            session,
            repository,
            authority,
            readCapabilities: () => null,
            readContentContext: () => null,
            renewAuthority: async () => ({ status: 'ok', value: authority }),
            isCurrent: () => true,
            onChange: value => { latest = value; },
        });
        await flushHookEffects({ cycles: 20 });

        expect(latest).toEqual({ status: 'unavailable', reason: 'forbidden' });
        expect(requests).toBe(0);
        stop();
    });

    it('coalesces one access renewal while the same record refresh publishes newer states', async () => {
        const repository = createSessionSystemRecordRepository({ scope, request: async () => new Response(JSON.stringify({
            records: [layout, record('note', 'item.v1', item)],
            nextCursor: null,
            hasNext: false,
        })) });
        let latest: SessionBoardBinding | undefined;
        let renewals = 0;
        let settleRenewal: ((value: { status: 'ok'; value: SessionBoardAuthority }) => void) | undefined;
        const stop = observeSessionBoard({
            session,
            repository,
            authority,
            readCapabilities: () => authority.capabilities,
            readContentContext: () => authority.contentContext,
            renewAuthority: async () => {
                renewals += 1;
                return await new Promise((resolve) => { settleRenewal = resolve; });
            },
            isCurrent: () => true,
            onChange: value => { latest = value; },
        });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh' } });

        repository.invalidate(session);
        await flushHookEffects({ cycles: 10 });
        expect(renewals).toBe(1);
        settleRenewal?.({ status: 'ok', value: authority });
        await flushHookEffects({ cycles: 50 });

        expect(renewals).toBe(1);
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh' } });
        stop();
    });

    it('renews access again when a retained stale Board reconnects', async () => {
        let recordsOffline = false;
        let authorityOffline = false;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            if (recordsOffline) throw new TypeError('offline');
            return new Response(JSON.stringify({ records: [layout], nextCursor: null, hasNext: false }));
        } });
        let latest: SessionBoardBinding | undefined;
        let renewals = 0;
        const stop = observeSessionBoard({
            session,
            repository,
            authority,
            readCapabilities: () => authority.capabilities,
            readContentContext: () => authority.contentContext,
            renewAuthority: async () => {
                renewals += 1;
                return authorityOffline ? { status: 'offline' } : { status: 'ok', value: authority };
            },
            isCurrent: () => true,
            onChange: value => { latest = value; },
        });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh' } });

        recordsOffline = true;
        authorityOffline = true;
        repository.invalidate(session);
        await flushHookEffects({ cycles: 50 });
        expect(renewals).toBe(1);
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'stale', reachability: 'offline' } });

        recordsOffline = false;
        authorityOffline = false;
        repository.refreshObserved({ force: true });
        await flushHookEffects({ cycles: 50 });
        expect(renewals).toBe(2);
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh', reachability: 'reachable' } });

        authorityOffline = true;
        repository.invalidate(session);
        await flushHookEffects({ cycles: 50 });
        expect(renewals).toBe(3);
        expect(repository.getSnapshot(session, { type: 'list', namespace: 'surface' }).freshness).toBe('fresh');
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'stale', reachability: 'offline' } });

        authorityOffline = false;
        repository.refreshObserved({ force: true });
        await flushHookEffects({ cycles: 50 });
        expect(renewals).toBe(4);
        expect(latest).toMatchObject({ status: 'ready', snapshot: { freshness: 'fresh', reachability: 'reachable' } });
        stop();
    });

    it('reopens cached encrypted bytes when the Session key arrives, without another record GET', async () => {
        let requests = 0;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            requests++;
            return new Response(JSON.stringify({ records: [{ ...layout, content: { t: 'encrypted', c: 'layout' } }, { ...record('note', 'item.v1', item), content: { t: 'encrypted', c: 'item' } }], nextCursor: null, hasNext: false }));
        } });
        let current: SessionBoardAuthority = { ...authority, contentContext: { mode: 'e2ee', encryption: null } };
        let latest: SessionBoardBinding | undefined;
        let authorityRenewals = 0;
        const stop = observeSessionBoard({
            session,
            repository,
            authority: current,
            readCapabilities: () => current.capabilities,
            readContentContext: () => current.contentContext,
            renewAuthority: async () => {
                authorityRenewals += 1;
                return { status: 'ok', value: current };
            },
            isCurrent: () => true,
            onChange: value => { latest = value; },
        });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { layoutState: { kind: 'locked' } } });
        // Crypto is the system boundary; codec, repository and projection stay real.
        current = { ...authority, contentContext: { mode: 'e2ee', encryption: { encryptRaw: async () => '', decryptRaw: async ciphertext => ciphertext === 'layout' ? layout.content.v : item } } };
        repository.notifyContentContextChanged(session);
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { layoutState: { kind: 'ready' } } });
        expect(requests).toBe(1);
        expect(authorityRenewals).toBe(0);
        current = { ...current, capabilities: { readTranscript: false, editSessionRecords: false } };
        repository.invalidate(session);
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
        repository.retire();
        expect(latest).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
        stop();
    });
});

describe('Board lifetime', () => {
    it('discards a late page when the Account repository retires', async () => {
        let resolve: ((response: Response) => void) | undefined;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => new Promise<Response>(settle => { resolve = settle; }) });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({ session, repository, authority, readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext, renewAuthority: async () => ({ status: 'ok', value: authority }), isCurrent: () => true, onChange: value => { latest = value; } });
        await flushHookEffects();
        repository.retire();
        resolve?.(new Response(JSON.stringify({ records: [layout], nextCursor: null, hasNext: false })));
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
        stop();
    });
});

describe('Board initial failure', () => {
    it('ends initial loading with an offline result when no stored content was read', async () => {
        let offline = true;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            if (offline) throw new TypeError('offline');
            return new Response(JSON.stringify({ records: [layout, record('note', 'item.v1', item)], nextCursor: null, hasNext: false }));
        } });
        let latest: SessionBoardBinding | undefined;
        const stop = observeSessionBoard({ session, repository, authority, readCapabilities: () => authority.capabilities, readContentContext: () => authority.contentContext, renewAuthority: async () => ({ status: 'ok', value: authority }), isCurrent: () => true, onChange: value => { latest = value; } });
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'unavailable', reason: 'offline' });
        offline = false;
        repository.refreshObserved();
        await flushHookEffects({ cycles: 50 });
        expect(latest).toMatchObject({ status: 'ready', snapshot: { reachability: 'reachable', incomplete: false } });
        stop();
    });
});
