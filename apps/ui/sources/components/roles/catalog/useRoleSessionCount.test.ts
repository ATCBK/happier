import { describe, expect, it } from 'vitest';

import { selectRoleSessionCount } from './useRoleSessionCount';

type State = Parameters<typeof selectRoleSessionCount>[0];

function sessionWithRole(roleId: string | null, archivedAt: number | null = null) {
    const metadata = roleId === null ? {} : { work: { sessionRolesV1: { roleId, overrides: {}, sessionRoles: {}, notes: '' } } };
    return { metadata, metadataLayoutVersion: 0, archivedAt };
}

describe('role session count', () => {
    it('counts live sessions that carry the role and ignores other roles, no role and archived sessions', () => {
        const state = { sessions: {
            a: sessionWithRole('orchestrator'),
            b: sessionWithRole('orchestrator'),
            c: sessionWithRole('builder'),
            d: sessionWithRole(null),
            e: sessionWithRole('orchestrator', 1700000000000),
        } } as unknown as State;
        expect(selectRoleSessionCount(state, 'orchestrator')).toBe(2);
        expect(selectRoleSessionCount(state, 'builder')).toBe(1);
        expect(selectRoleSessionCount(state, 'planner')).toBe(0);
    });
});
