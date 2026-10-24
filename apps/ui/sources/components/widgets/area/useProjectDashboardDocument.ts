import * as React from 'react';
import { readWidgetSurfaceArtifactV1, type WidgetSurfaceRefV1, type WidgetAreaLayoutSummaryV1 } from '@happier-dev/protocol/widgets';
import { ArtifactCallerAccessV1Schema, type ArtifactCallerAccessV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { useActiveServerAccountScopeLifetime, useArtifact } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { isArtifactOnlyHomeAccountChange, subscribeHomeAccountChange, subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

export type ProjectDashboardDocumentRead = Readonly<{ artifactId: string; surface: WidgetSurfaceRefV1; name: string;
    access: ArtifactCallerAccessV1; revision: WidgetAreaLayoutSummaryV1['revision']; viewerScope: ServerAccountScope }>;

/** Summary and mounted binding share the exact Artifact read, codec and viewer authority. */
export function useProjectDashboardDocument(reference: Readonly<{ artifactId: string; serverId?: string }> | null, defaultServerId: string) {
    const lifetime = useActiveServerAccountScopeLifetime();
    const viewer = lifetime?.scope ?? null;
    const serverId = reference?.serverId ?? defaultServerId;
    const publication = useArtifact(reference?.artifactId ?? '');
    const localPublication = areServerProfileIdentifiersEquivalent(serverId, defaultServerId) ? publication : null;
    const key = reference ? JSON.stringify([lifetime?.scope, serverId, reference.artifactId]) : '';
    const [wake, setWake] = React.useState(0);
    const [read, setRead] = React.useState<Readonly<{ key: string; publication: typeof publication; document: ProjectDashboardDocumentRead | null }>>({
        key: '', publication: null, document: null,
    });
    React.useEffect(() => {
        if (!reference || !lifetime?.isCurrent()) return;
        const refresh = () => setWake(previous => previous + 1);
        const accountChange = subscribeHomeAccountChange(event => {
            if (!areServerProfileIdentifiersEquivalent(event.serverId, serverId)
                || (event.changeKinds && !event.changeKinds.includes('artifact'))) return;
            if (isArtifactOnlyHomeAccountChange(event) && event.entityIds !== undefined
                && !event.entityIds.includes(reference.artifactId)) return;
            refresh();
        });
        const credentialChange = subscribeHomeCredentialChange(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, serverId)) {
                setRead({ key: '', publication: null, document: null });
                refresh();
            }
        });
        return () => { accountChange(); credentialChange(); };
    }, [key, lifetime, serverId]);
    React.useEffect(() => {
        if (!reference || !lifetime?.isCurrent()) return;
        const controller = new AbortController();
        void (async () => {
            try {
                const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
                const account = await captureLazyActionAccountContext(serverId, controller.signal);
                try {
                    const row = await account.readArtifactContent(reference.artifactId, { signal: controller.signal });
                    const layout = row ? readWidgetSurfaceArtifactV1(row) : null;
                    if (!layout || layout.surface.owner.kind !== 'project' || row?.ownerAccountId !== layout.surface.accountId
                        || !areServerProfileIdentifiersEquivalent(layout.surface.serverId, account.serverId)) throw new Error('widget_area_owner_mismatch');
                    account.assertCurrent();
                    if (!controller.signal.aborted && lifetime.isCurrent()) setRead({ key, publication: localPublication,
                        document: { artifactId: reference.artifactId, surface: { ...layout.surface, artifactId: reference.artifactId },
                            name: layout.name ?? t('projects.pages.overview'), access: ArtifactCallerAccessV1Schema.parse(row.access), revision: row.revision,
                            viewerScope: { serverId: account.serverId, accountId: account.accountId } } });
                } finally { account.dispose(); }
            } catch {
                if (!controller.signal.aborted && lifetime.isCurrent()) setRead({ key, publication: localPublication, document: null });
            }
        })();
        return () => controller.abort();
    }, [key, lifetime, localPublication, serverId, wake]);
    const loaded = !!reference && lifetime?.isCurrent() === true && read.key === key && read.publication === localPublication;
    return { loaded, document: loaded ? read.document : null };
}
