import { createHappierCollectionVisitMemory } from '@happier-dev/plugin-ui/presentation';

/** Settings › Roles: the collection's own route. */
export const ROLES_COLLECTION_ROOT = '/settings/roles';
const NEW_ROLE_SEGMENT = 'new';

export function roleRoute(roleId: string): string {
    return `${ROLES_COLLECTION_ROOT}/${encodeURIComponent(roleId)}`;
}

export function newRoleRoute(): string {
    return `${ROLES_COLLECTION_ROOT}/${NEW_ROLE_SEGMENT}`;
}

export type RoleCollectionSelection =
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'draft' }>
    | Readonly<{ kind: 'role'; roleId: string }>;

/** What the route selects; the rail highlights it and the detail pane shows it. */
export function resolveRoleCollectionSelection(pathname: string): RoleCollectionSelection {
    const normalized = pathname.replace(/\/+$/, '');
    if (!normalized.startsWith(`${ROLES_COLLECTION_ROOT}/`)) return { kind: 'none' };
    const segment = normalized.slice(ROLES_COLLECTION_ROOT.length + 1).split('/')[0] ?? '';
    if (!segment) return { kind: 'none' };
    if (segment === NEW_ROLE_SEGMENT) return { kind: 'draft' };
    return { kind: 'role', roleId: decodeURIComponent(segment) };
}

/** The nested stack screen shown at `pathname` (registry names under the `roles` navigator). */
export function resolveRolesChildRoute(pathname: string): string {
    const selection = resolveRoleCollectionSelection(pathname);
    if (selection.kind === 'draft') return 'new';
    if (selection.kind === 'role') return '[roleId]';
    return 'index';
}

/** The role last opened during this app session; a wide collection lands on it. */
const roleVisits = createHappierCollectionVisitMemory<string>();
export const recordRoleCollectionVisit = roleVisits.record;
export const readLastVisitedRoleId = roleVisits.read;
