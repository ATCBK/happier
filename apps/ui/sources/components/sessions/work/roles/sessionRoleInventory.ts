import type { SessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { resolvedRoleToArtifact, type RoleCatalogEntry } from '@/sync/domains/roles/roleCatalog';

export type SessionRoleInventoryRow = Readonly<{
    roleId: string;
    override: SessionRolesV1['overrides'][string] | undefined;
    snapshot: SessionRolesV1['sessionRoles'][string] | undefined;
    enabled: boolean;
    /** null: the role matches Settings. */
    kind: 'changed' | 'session' | null;
    reset: 'override' | 'snapshot';
}>;

/**
 * Every role this session can use, and how it differs from Settings. A spawn snapshot is compared with
 * the Role catalog only once the catalog is known: before that, every inherited role would read as
 * "this session" and the count would settle on a different number when the catalog arrives.
 */
export function buildSessionRoleInventory(input: Readonly<{
    entries: ReadonlyArray<RoleCatalogEntry>;
    catalogKnown: boolean;
    sessionRoles: SessionRolesV1;
}>): ReadonlyArray<SessionRoleInventoryRow> {
    const { sessionRoles } = input;
    const catalogById = new Map(input.entries.map(entry => [entry.roleId, entry]));
    const ids = new Set([...Object.keys(sessionRoles.overrides), ...Object.keys(sessionRoles.sessionRoles), ...catalogById.keys()]);
    return [...ids].map(roleId => {
        const entry = catalogById.get(roleId);
        const snapshot = sessionRoles.sessionRoles[roleId];
        const override = sessionRoles.overrides[roleId];
        const resolved = resolveRoleSelectionV1({ roleId, settingsRoles: entry ? { [roleId]: entry.role } : {},
            settingsOverrides: entry?.override ? { [roleId]: entry.override } : {}, sessionRoles });
        const snapshotDiffers = input.catalogKnown && snapshot
            && (!entry || !sameStrictJsonValue(resolvedRoleToArtifact(snapshot), resolvedRoleToArtifact(entry.role)));
        return { roleId, override, snapshot, enabled: resolved.ok,
            kind: override || (snapshotDiffers && entry) ? 'changed' as const : snapshotDiffers ? 'session' as const : null,
            reset: override ? 'override' as const : 'snapshot' as const };
    });
}
