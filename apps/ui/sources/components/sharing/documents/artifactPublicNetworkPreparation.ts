import { ArtifactActionOutputSchemasV1, ArtifactHeaderMetadataV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { artifactHtmlBundleFromBodyV1, ARTIFACT_HTML_BUNDLE_MIME_V1, type ArtifactHtmlBundleV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { getArtifactUseTargetV1, readArtifactPublicNetworkPolicyV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import type { UiSurfaceNetworkPolicyV1 } from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1';
import { WidgetDefinitionV1Schema, readWidgetDefinitionArtifactV1, buildWidgetDefinitionArtifactHeaderV1 } from '@happier-dev/protocol/widgets';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';

export type ArtifactPublicNetworkOpenedV1 = NonNullable<ReturnType<typeof ArtifactActionOutputSchemasV1['artifact.get']['parse']>['artifact']>;
export type ArtifactPublicNetworkResourceV1 = Readonly<{ policy: UiSurfaceNetworkPolicyV1; htmlBundle?: ArtifactHtmlBundleV1 }>;
type CapturedArtifactReader = Pick<LazyActionAccountContext, 'serverId' | 'accountId' | 'assertCurrent' | 'readArtifactHtmlBundle'>;

/** The same authenticated content/revision supplies both Share and original Action approval. */
export async function readArtifactPublicNetworkResource(input: Readonly<{
    opened: ArtifactPublicNetworkOpenedV1; scope: ServerAccountScope; account?: CapturedArtifactReader; signal?: AbortSignal;
}>): Promise<ArtifactPublicNetworkResourceV1> {
    input.signal?.throwIfAborted();
    const { opened, scope } = input;
    let htmlBundle: ArtifactHtmlBundleV1 | undefined;
    input.account?.assertCurrent();
    if (input.account && (input.account.serverId !== scope.serverId || input.account.accountId !== scope.accountId)) {
        throw new HappyError(t('errors.permissionDenied'), false);
    }
    if (opened.header.kind === 'html') {
        if (typeof opened.body === 'string') {
            htmlBundle = artifactHtmlBundleFromBodyV1(opened.body, typeof opened.header.mime === 'string' ? opened.header.mime : undefined, 'stored');
        } else {
            const ownedAccount = input.account ? null : await captureLazyActionAccountContext(scope.serverId);
            const account = input.account ?? ownedAccount!;
            try {
                account.assertCurrent();
                if (account.serverId !== scope.serverId || account.accountId !== scope.accountId) {
                    throw new HappyError(t('errors.permissionDenied'), false);
                }
                const read = await account.readArtifactHtmlBundle(opened.artifactId, input.signal);
                account.assertCurrent();
                input.signal?.throwIfAborted();
                if (read.revision.headerVersion !== opened.revision.headerVersion || read.revision.bodyVersion !== opened.revision.bodyVersion) {
                    throw new HappyError(t('session.collaboration.pane.linkLoadFailed'), true);
                }
                htmlBundle = read.bundle;
            } finally { ownedAccount?.dispose(); }
        }
    }
    const policy = readArtifactPublicNetworkPolicyV1({ ...opened, ...(htmlBundle ? { htmlBundle } : {}) });
    if (!policy) throw new HappyError(t('session.collaboration.pane.linkLoadFailed'), false);
    return { policy, ...(htmlBundle ? { htmlBundle } : {}) };
}

/** No issuance or replay here. Only a committed update permits the caller to continue. */
export async function prepareArtifactPublicNetworkOff(input: Readonly<{
    opened: ArtifactPublicNetworkOpenedV1; resource: ArtifactPublicNetworkResourceV1;
    request: (actionId: 'artifact.update', payload: unknown) => Promise<unknown | null>;
    isCurrent: () => boolean;
}>): Promise<Readonly<{ kind: 'ready'; policy: UiSurfaceNetworkPolicyV1 }> | Readonly<{ kind: 'pending' | 'cancelled' }>> {
    if (!input.isCurrent()) return { kind: 'cancelled' };
    const { opened, resource } = input;
    if (resource.policy.network === 'none') return { kind: 'ready', policy: resource.policy };
    let header = opened.header;
    let body: string;
    if (opened.header.kind === 'html') {
        const bundle = resource.htmlBundle;
        if (!bundle) throw new HappyError(t('session.collaboration.pane.linkLoadFailed'), false);
        const { networkOrigins: _origins, ...capabilities } = bundle.requestedCapabilities ?? {};
        body = JSON.stringify({ ...bundle, requestedCapabilities: { ...capabilities, network: 'none' } });
        header = { ...header, mime: ARTIFACT_HTML_BUNDLE_MIME_V1 };
    } else if (opened.header.kind === 'widget-definition.v1') {
        if (typeof opened.body !== 'string') throw new HappyError(t('session.collaboration.pane.linkLoadFailed'), false);
        // Sharing admission inspects raw stored inputs before projection can drop a private pin.
        if (!getArtifactUseTargetV1(opened).publicLinkAllowed) throw new HappyError(t('errors.permissionDenied'), false);
        const definition = readWidgetDefinitionArtifactV1(opened);
        const next = WidgetDefinitionV1Schema.parse({ ...definition, networkOverride: { network: 'none' },
            ...(definition.body.kind === 'html' ? { body: { ...definition.body,
                requestedCapabilities: { ...definition.body.requestedCapabilities, networkOrigins: [], network: 'none' } } } : {}) });
        header = ArtifactHeaderMetadataV1Schema.parse(buildWidgetDefinitionArtifactHeaderV1(next));
        body = JSON.stringify(next);
    } else throw new HappyError(t('session.collaboration.pane.linkLoadFailed'), false);
    // The request preserves ordinary Action approval; null is custody, not a write receipt.
    const updated = await input.request('artifact.update', { artifactId: opened.artifactId, expectedRevision: opened.revision, header, body });
    if (!input.isCurrent()) return { kind: 'cancelled' };
    if (updated === null) return { kind: 'pending' };
    ArtifactActionOutputSchemasV1['artifact.update'].parse(updated);
    return { kind: 'ready', policy: { network: 'none', networkOrigins: [] } };
}
