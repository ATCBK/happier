import { expect, it } from 'vitest';
import { projectReviewEvidenceSessions } from './projectReviewEvidenceSessions';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListReachabilityRenderableKey } from '@/sync/domains/state/storage';

it('does not publish a new evidence list when repeated roster observations have no admitted Session', () => {
    const scope = { machineId: 'perf-machine', rootPath: '/repo' };
    let previous = projectReviewEvidenceSessions([], new Map(), scope);
    let publications = 0;
    for (let arrival = 0; arrival < 20; arrival++) {
        const next = projectReviewEvidenceSessions([], new Map(), scope);
        if (next !== previous) publications++;
        previous = next;
    }
    expect(previous).toEqual([]);
    expect(publications).toBe(0);
});

it('publishes populated evidence only when its admitted name, turn or membership changes', () => {
    const scope = { machineId: 'perf-machine', rootPath: '/repo' };
    let row = createSessionListRenderableSessionFixture({ id: 'review-session', latestTurnId: 'turn-1',
        metadata: { machineId: scope.machineId, path: scope.rootPath, host: 'fixture', name: 'Review' } });
    const items = [{ type: 'session' as const, sessionId: row.id, serverId: 'review-home' }];
    const key = buildSessionListReachabilityRenderableKey(items[0].serverId, row.id)!;
    const read = (previous?: ReturnType<typeof projectReviewEvidenceSessions>) =>
        projectReviewEvidenceSessions(items, new Map([[key, row]]), scope, previous);
    let previous = read();
    expect(previous).toMatchObject([{ sessionId: row.id, label: 'Review', latestTurnId: 'turn-1' }]);
    let publications = 0;
    for (let arrival = 1; arrival <= 20; arrival++) {
        row = { ...row, seq: row.seq + 1, updatedAt: arrival + 1, thinking: arrival % 2 === 0 };
        const next = read(previous);
        if (next !== previous) publications++;
        previous = next;
    }
    expect(publications).toBe(0);
    row = { ...row, metadata: { ...row.metadata!, name: 'Renamed' }, latestTurnId: 'turn-2' };
    const renamed = read(previous);
    expect(renamed).not.toBe(previous);
    expect(renamed).toMatchObject([{ sessionId: row.id, label: 'Renamed', latestTurnId: 'turn-2' }]);
    const withdrawn = projectReviewEvidenceSessions([], new Map(), scope, renamed);
    expect(withdrawn).toEqual([]);
    expect(withdrawn).not.toBe(renamed);
});
