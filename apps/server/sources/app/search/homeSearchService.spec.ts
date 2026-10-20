import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openHomeSearchDb } from './homeSearchDb';
import { createHomeSearchService } from './homeSearchService';

describe('Home search service', () => {
    it('fails closed for encrypted homes and exposes identity on plain hits', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-service-'));
        const encrypted = createHomeSearchService({ db: null, homeServerIdentityId: 'srv_test', storagePolicy: 'e2ee' });
        expect(encrypted.capability()).toEqual({ enabled: false, reason: 'index_unavailable' });
        expect(encrypted.search({ v: 1, query: 'x', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: false, errorCode: 'memory_disabled' });

        const path = join(root, 'plain.sqlite');
        const index = await openHomeSearchDb({ dbPath: path });
        index.upsert({ id: 'm-1', sessionId: 's-1', seq: 1, createdAtMs: 1, text: 'plain message' });
        const plain = createHomeSearchService({ db: index, homeServerIdentityId: 'srv_test', storagePolicy: 'plaintext_only' });
        expect(plain.search({ v: 1, query: 'plain', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: true, hits: [expect.objectContaining({ homeServerIdentityId: 'srv_test' })] });
        expect(plain.search({ v: 1, query: 'plain', scope: { type: 'global' }, mode: 'auto' }, { visibleSessions: [] })).toMatchObject({ ok: true, hits: [] });
        expect(plain.search({ v: 1, query: 'plain', scope: { type: 'session', sessionId: 'other' }, mode: 'auto' }, {
            visibleSessions: [{ sessionId: 's-1', maximumSeq: null }],
        })).toMatchObject({ ok: true, hits: [] });
        expect(plain.search({ v: 1, query: 'plain', scope: { type: 'project',
            projectRef: { serverId: 'srv_test', projectKey: 'payments' } }, mode: 'auto' }))
            .toMatchObject({ ok: false, errorCode: 'memory_project_scope_unsupported' });
        index.close();
    });

    it('is not ready while the initial index reconciliation is pending', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-service-indexing-'));
        const index = await openHomeSearchDb({ dbPath: join(root, 'search.sqlite') });
        let ready = false;
        const service = createHomeSearchService({
            db: index,
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
            isReady: () => ready,
        });
        expect(service.capability()).toEqual({ enabled: false, reason: 'indexing' });
        expect(service.search({ v: 1, query: 'x', scope: { type: 'global' }, mode: 'auto' })).toMatchObject({ ok: false, errorCode: 'memory_index_missing' });

        ready = true;
        expect(service.capability()).toEqual({ enabled: true });
        index.close();
    });

    it('applies contextual Session eligibility before the Home result limit', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-service-eligibility-'));
        const index = await openHomeSearchDb({ dbPath: join(root, 'search.sqlite') });
        for (let value = 1; value <= 3; value += 1) {
            index.upsert({
                id: `active-message-${value}`,
                sessionId: `active-${value}`,
                seq: 1,
                createdAtMs: 100 + value,
                text: 'shared eligibility term',
            });
        }
        index.upsert({
            id: 'archived-message',
            sessionId: 'archived-target',
            seq: 1,
            createdAtMs: 1,
            text: 'shared eligibility term',
        });
        const service = createHomeSearchService({
            db: index,
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
        });

        expect(service.search({
            v: 1,
            query: 'eligibility',
            scope: { type: 'global' },
            mode: 'auto',
            maxResults: 2,
            eligibleSessionIds: ['archived-target'],
        }, {
            visibleSessions: ['active-1', 'active-2', 'active-3', 'archived-target']
                .map((sessionId) => ({ sessionId, maximumSeq: null })),
        })).toEqual(expect.objectContaining({
            ok: true,
            hits: [expect.objectContaining({ sessionId: 'archived-target' })],
        }));
        index.close();
    });

    it('applies eligible Session IDs for internal searches without a visibility context', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-service-internal-eligibility-'));
        const index = await openHomeSearchDb({ dbPath: join(root, 'search.sqlite') });
        index.upsert({
            id: 'excluded-message',
            sessionId: 'excluded-session',
            seq: 1,
            createdAtMs: 2,
            text: 'shared internal eligibility term',
        });
        index.upsert({
            id: 'eligible-message',
            sessionId: 'eligible-session',
            seq: 1,
            createdAtMs: 1,
            text: 'shared internal eligibility term',
        });
        const service = createHomeSearchService({
            db: index,
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
        });

        expect(service.search({
            v: 1,
            query: 'eligibility',
            scope: { type: 'global' },
            mode: 'auto',
            maxResults: 1,
            eligibleSessionIds: ['eligible-session'],
        })).toEqual(expect.objectContaining({
            ok: true,
            hits: [expect.objectContaining({ sessionId: 'eligible-session' })],
        }));
        index.close();
    });

    it('intersects high-cardinality eligible and visible Sessions without linear membership scans', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-home-service-large-eligibility-'));
        const index = await openHomeSearchDb({ dbPath: join(root, 'search.sqlite') });
        const sessionCount = 5_000;
        const eligibleSessionIds = Array.from({ length: sessionCount }, (_, index) => `eligible-${index}`);
        const visibleSessions = eligibleSessionIds.map((sessionId) => ({ sessionId, maximumSeq: null }));
        index.upsert({
            id: 'large-eligible-message',
            sessionId: eligibleSessionIds.at(-1)!,
            seq: 1,
            createdAtMs: 1,
            text: 'high cardinality membership probe',
        });
        const service = createHomeSearchService({
            db: index,
            homeServerIdentityId: 'srv_test',
            storagePolicy: 'plaintext_only',
        });
        const includes = vi.spyOn(Array.prototype, 'includes');

        const result = service.search({
            v: 1,
            query: 'membership',
            scope: { type: 'global' },
            mode: 'auto',
            eligibleSessionIds,
        }, { visibleSessions });
        const eligibleMembershipScans = includes.mock.instances.filter((instance) => (
            Array.isArray(instance)
            && instance.length === sessionCount
            && instance[0] === 'eligible-0'
        ));
        includes.mockRestore();

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            hits: [expect.objectContaining({ sessionId: eligibleSessionIds.at(-1) })],
        }));
        expect(eligibleMembershipScans).toHaveLength(0);
        index.close();
    });
});
