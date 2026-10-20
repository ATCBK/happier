import { describe, expect, it } from 'vitest';
import { resolveRolesSnapshotV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { snapshotSessionRolesAtSpawnV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import type { RoleCatalogEntry } from '@/sync/domains/roles/roleCatalog';

import { buildSessionRoleInventory } from './sessionRoleInventory';

const inherited = snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles: resolveRolesSnapshotV1({
    settingsOverrides: { builder: { roleId: 'builder', instructionsOverride: 'Inherited build instructions.' } },
}) });

// The Settings layer as the catalog projects it: every built-in role, no override of the reader's own.
const builtInEntries: RoleCatalogEntry[] = Object.entries(resolveRolesSnapshotV1({})).map(([roleId, role]) => ({
    roleId, source: 'built_in', role, viewOnly: false, migratedFromV0_2: false,
}));

describe('buildSessionRoleInventory', () => {
    it('reports only the inherited role that differs from Settings once the catalog is known', () => {
        const rows = buildSessionRoleInventory({ entries: builtInEntries, catalogKnown: true, sessionRoles: inherited });
        expect(rows.filter(row => row.kind !== null).map(row => [row.roleId, row.kind])).toEqual([['builder', 'changed']]);
    });

    it('does not call every inherited role a session addition before the catalog is known', () => {
        const rows = buildSessionRoleInventory({ entries: [], catalogKnown: false, sessionRoles: inherited });
        expect(rows.filter(row => row.kind !== null)).toEqual([]);
    });

    it('still reports a session override while the catalog is unknown', () => {
        const rows = buildSessionRoleInventory({ entries: [], catalogKnown: false, sessionRoles: {
            ...inherited, overrides: { planner: { roleId: 'planner', workspaceWrites: 'deny' } },
        } });
        expect(rows.filter(row => row.kind !== null).map(row => [row.roleId, row.kind, row.reset])).toEqual([['planner', 'changed', 'override']]);
    });
});
