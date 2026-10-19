import { describe, expect, it } from 'vitest';

import { orderRowsForSessionListHydration } from './sessionListHydrationPriority';

describe('orderRowsForSessionListHydration', () => {
    it('keeps offscreen agents and reports as projections until explicitly demanded', () => {
        const result = orderRowsForSessionListHydration({
            rows: [{ id: 'unrelated', active: false },
                { id: 'child', active: true, manager: { sessionId: 'lead' } },
                { id: 'grandchild', active: false, manager: { sessionId: 'child' } }],
            eagerHydrationCount: 0, maxBackgroundHydrationRows: 0,
        });
        expect(result.rows).toEqual([]);
        expect(result.reasonCounts).toMatchObject({ priority: 0, active: 0, skippedBackground: 3 });
    });
    it('keeps required and route ids ahead of active viewing ids', () => {
        const params = {
            rows: [
                { id: 's_active', active: false },
                { id: 's_route', active: false },
                { id: 's_required', active: false },
                { id: 's_eager', active: false },
            ],
            requiredSessionIds: ['s_required'],
            routeSessionIds: ['s_route'],
            activeSessionIds: ['s_active'],
            eagerHydrationCount: 1,
        };

        const result = orderRowsForSessionListHydration(params);

        expect(result.rows.map((row) => row.id)).toEqual([
            's_required',
            's_route',
            's_active',
            's_eager',
        ]);
        expect(result.reasonCounts).toEqual({
            required: 1,
            route: 1,
            active: 1,
            priority: 0,
            eager: 1,
            background: 0,
            skippedBackground: 0,
        });
    });

    it('hydrates only explicit viewing demand when background hydration is omitted', () => {
        const params = {
            rows: [
                { id: 's_background', active: false },
                { id: 's_active', active: true },
                { id: 's_visible', active: false },
            ],
            activeSessionIds: ['s_visible'],
            eagerHydrationCount: 0,
        };

        const result = orderRowsForSessionListHydration(params);

        expect(result.rows.map((row) => row.id)).toEqual([
            's_visible',
        ]);
        expect(result.reasonCounts).toEqual({
            required: 0,
            route: 0,
            active: 1,
            priority: 0,
            eager: 0,
            background: 0,
            skippedBackground: 2,
        });
    });

    it('deduplicates explicit demands by precedence and defers undemanded rows', () => {
        const result = orderRowsForSessionListHydration({
            rows: [
                { id: 's_active', active: true },
                { id: 's_background', active: false },
                { id: 's_priority', active: false },
                { id: 's_required', active: false },
                { id: 's_route', active: false },
            ],
            requiredSessionIds: [' s_required ', 's_required', 'missing'],
            routeSessionIds: ['s_required', 's_route'],
            activeSessionIds: ['s_route', 's_active'],
            prioritySessionIds: ['s_active', 's_priority', '', 's_priority'],
        });

        expect(result.rows.map((row) => row.id)).toEqual([
            's_required',
            's_route',
            's_active',
            's_priority',
        ]);
        expect(result.reasonCounts).toEqual({
            required: 1,
            route: 1,
            active: 1,
            priority: 1,
            eager: 0,
            background: 0,
            skippedBackground: 1,
        });
        expect(Array.from(result.reasonById)).toEqual([
            ['s_required', 'required'],
            ['s_route', 'route'],
            ['s_active', 'active'],
            ['s_priority', 'priority'],
        ]);
    });

    it('caps only generic background hydration after eager rows', () => {
        const params: Parameters<typeof orderRowsForSessionListHydration>[0] & { maxBackgroundHydrationRows: number } = {
            rows: [
                { id: 's_required', active: false },
                { id: 's_route', active: false },
                { id: 's_active', active: true },
                { id: 's_eager', active: false },
                { id: 's_background_1', active: false },
                { id: 's_background_2', active: false },
            ],
            requiredSessionIds: ['s_required'],
            routeSessionIds: ['s_route'],
            activeSessionIds: ['s_active'],
            eagerHydrationCount: 1,
            maxBackgroundHydrationRows: 1,
        };

        const result = orderRowsForSessionListHydration(params);

        expect(result.rows.map((row) => row.id)).toEqual([
            's_required',
            's_route',
            's_active',
            's_eager',
            's_background_1',
        ]);
        expect(result.reasonCounts).toEqual({
            required: 1,
            route: 1,
            active: 1,
            priority: 0,
            eager: 1,
            background: 1,
            skippedBackground: 1,
        });
    });
});
