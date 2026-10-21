import type { HomeAtmosphere, ProjectAtmosphere } from '@happier-dev/protocol/account/settings/accountSettings';
import type { SettingsMutationServices } from '@/components/settings/catalog/settingDeclarations';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { projectAtmosphereEdit } from './look/projectAtmosphereEdit';

type ProjectAtmosphereContext = Readonly<{
    rows: NonNullable<SettingsMutationServices['projectAccountRows']>;
    scope: ServerAccountScope | undefined;
    target: Readonly<{ serverId: string; projectKey: string }>;
    signal?: AbortSignal;
    isCurrent(): boolean;
}>;

/** Project Settings and Look share the same captured row/CAS boundary. */
export async function readProjectAtmosphereSetting(context: ProjectAtmosphereContext) {
    if (!context.isCurrent()) return null;
    const snapshot = await context.rows.read(context.signal);
    if (!context.isCurrent() || !context.scope || snapshot.scope.serverId !== context.target.serverId
        || snapshot.scope.accountId !== context.scope.accountId || context.scope.serverId !== context.target.serverId
        || snapshot.status !== 'ready' || snapshot.coverage !== 'complete') return null;
    const row = snapshot.organizations.find(row => row.key.serverId === context.target.serverId && row.key.projectKey === context.target.projectKey);
    return { row, value: row?.value.atmosphere ?? 'home' as const };
}

/** Reapply an intent to the row owner's fresh value, preserving every other Project field. */
export async function mutateProjectAtmosphereSetting(context: ProjectAtmosphereContext & Readonly<{
    readHome(): Promise<HomeAtmosphere>;
    edit: 'home' | ((value: ProjectAtmosphere) => ProjectAtmosphere);
}>) {
    const current = await readProjectAtmosphereSetting(context);
    if (!current) return { status: 'unavailable' as const };
    const home = await context.readHome();
    if (!context.isCurrent()) return { status: 'unavailable' as const };
    const result = await context.rows.mutateOrganization({ ...context.target, expectedRevision: current.row?.revision ?? 'absent', signal: context.signal,
        mutate: value => {
            if (!context.isCurrent()) throw new Error('project_account_scope_changed');
            return { ...value, atmosphere: context.edit === 'home' ? 'home'
                : projectAtmosphereEdit(home, value.atmosphere, context.edit) };
        } });
    if (!context.isCurrent()) return { status: 'unavailable' as const };
    return result.status === 'updated' ? { status: 'updated' as const, value: result.value.atmosphere ?? 'home' as const }
        : { status: 'conflict' as const };
}
