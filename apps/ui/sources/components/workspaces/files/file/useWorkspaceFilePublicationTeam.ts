import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { readSourceTeamId } from '@/components/projects/sources/projectSourceGroups';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { useActiveServerAccountScopeLifetime, useSessionSelector } from '@/sync/store/hooks';

/** Resolve only source-authored audience context; Account membership is never a source Team. */
export function useWorkspaceFilePublicationTeam(input: Readonly<{
    scope: ServerAccountScope | null;
    sourceSessionId: string | null;
    sourceProject?: WorkspaceRefV1 | null;
    enabled: boolean;
}>) {
    const primaryTeamId = useSessionSelector(input.sourceSessionId ?? '', input.scope?.serverId,
        session => session?.access?.primaryTeamId ?? null);
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = input.enabled && input.scope && activeLifetime
        && areServerAccountScopesEqual(input.scope, activeLifetime.scope) ? activeLifetime : null;
    const sourceId = !primaryTeamId && input.sourceProject?.serverId === input.scope?.serverId
        ? input.sourceProject?.source?.sourceId ?? null : null;
    const projectSource = useProjectSource(lifetime, sourceId);
    const teamId = primaryTeamId ?? (projectSource.source ? readSourceTeamId(projectSource.source.source) : null);
    const binding = useTeamBinding(input.enabled && teamId ? input.scope?.serverId ?? '' : '', input.enabled ? teamId ?? '' : '');
    const team = binding.kind === 'bound' && binding.state.kind === 'ready'
        && areServerAccountScopesEqual(binding.scope, input.scope)
        ? { teamId: binding.state.team.id, name: binding.state.team.name } : null;
    const loading = input.enabled && ((sourceId && !projectSource.source && (projectSource.status === 'initial' || projectSource.status === 'loading'))
        || (teamId && (binding.kind === 'resolving' || (binding.kind === 'bound' && (binding.state.kind === 'unobserved' || binding.state.kind === 'loading')))));
    return { team, loading: Boolean(loading), unavailable: Boolean(input.enabled && (teamId || sourceId) && !team && !loading) };
}
