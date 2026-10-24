import { expect, it } from 'vitest';
import { projectReviewEvidenceSessions } from './projectReviewEvidenceSessions';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListReachabilityRenderableKey } from '@/sync/domains/state/storage';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';

it('PF4 retains each unchanged evidence row across a one-Session change and reordering', async () => {
    const scope = { machineId: 'perf-machine', rootPath: '/repo' };
    const records = Array.from({ length: 150 }, (_, index) => createSessionListRenderableSessionFixture({
        id: `review-${index}`, latestTurnId: 'turn-1',
        metadata: { machineId: scope.machineId, path: scope.rootPath, host: 'fixture', name: `Review ${index}` },
    }));
    const items = records.map(row => ({ type: 'session' as const, sessionId: row.id, serverId: 'review-home' }));
    const rows = new Map(records.map(row => [buildSessionListReachabilityRenderableKey('review-home', row.id)!, row]));
    const before = projectReviewEvidenceSessions(items, rows, scope);
    const renders: string[] = [];
    const Row = React.memo(({ row }: { row: typeof before[number] }) => { renders.push(row.sessionId); return null; });
    const renderRows = (evidence: typeof before) => React.createElement(React.Fragment, null,
        evidence.map(row => React.createElement(Row, { key: row.sessionId, row })));
    const screen = await renderScreen(renderRows(before));
    renders.length = 0;
    let publications = 0;
    for (let index = 0; index < 5; index++) {
        const next = projectReviewEvidenceSessions([...items], new Map(rows), scope, before);
        if (next !== before) publications++;
        await act(async () => { screen.update(renderRows(next)); });
    }
    expect(publications).toBe(0);
    expect(renders).toHaveLength(0);
    const changed = records[42];
    rows.set(buildSessionListReachabilityRenderableKey('review-home', changed.id)!, { ...changed, latestTurnId: 'turn-2' });
    const after = projectReviewEvidenceSessions([...items].reverse(), rows, scope, before);
    expect(after).not.toBe(before);
    expect(after.find(row => row.sessionId === changed.id)).toMatchObject({ latestTurnId: 'turn-2' });
    await act(async () => { screen.update(renderRows(after)); });
    expect({ retained: after.filter(row => row === before.find(previous => previous.sessionId === row.sessionId)).length,
        renders }).toEqual({ retained: 149, renders: [changed.id] });
});

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
