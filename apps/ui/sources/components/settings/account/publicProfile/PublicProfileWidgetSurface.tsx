import * as React from 'react';
import { HappierPublicProfileWidget, type HappierPublicProfileLabels, type HappierPublicProfileUsageHost } from '@happier-dev/plugin-ui/presentation';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, type PublicProfileSnapshotV1 } from '@happier-dev/protocol/account/publicProfile';
import { projectPublicProfilePreview } from '@happier-dev/protocol/account/projectPublicProfile';
import { PublicProfilePreviewResultV1Schema } from '@happier-dev/protocol/account/publicProfileIntents';
import { resolveWidgetPublicSnapshotPresentationV1, type WidgetInstanceV1, type WidgetSizeV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { t } from '@/text';
import { publicProfilePageLabels, usePublicProfileUsageHost } from './publicProfilePresentation';
import { usePublicProfileOwnerRead } from './usePublicProfileOwnerRead';
import { DEFAULT_PUBLIC_PROFILE_QUERY } from './publicProfileDraft';

type PreviewSource = Omit<Parameters<typeof projectPublicProfilePreview>[0], 'layout'>;
export const PublicProfileWidgetPreviewContext = React.createContext<Readonly<{
  source: PreviewSource; labels: HappierPublicProfileLabels; usage?: HappierPublicProfileUsageHost;
}> | null>(null);

/** A whole area/group shares its existing preview owner; standalone setup reads it once. */
export function PublicProfileWidgetPreviewBoundary(props: Readonly<{ scope: WidgetSurfaceRefV1; children: React.ReactNode }>) {
  const preview = React.useContext(PublicProfileWidgetPreviewContext);
  return preview ? props.children : <ReadPublicProfileWidgetPreview key={JSON.stringify([props.scope.serverId, props.scope.accountId])}
    scope={props.scope}>{props.children}</ReadPublicProfileWidgetPreview>;
}

function ReadPublicProfileWidgetPreview(props: Readonly<{ scope: WidgetSurfaceRefV1; children: React.ReactNode }>) {
  const execution = useMountedActionExecution(props.scope);
  const { state } = usePublicProfileOwnerRead(execution);
  const read = state.kind === 'ready' ? state.read : null;
  const record = read?.kind === 'ready' ? read.record : null;
  const [local, setLocal] = React.useState<PublicProfileSnapshotV1 | null>(null);
  const [failed, setFailed] = React.useState(false);
  const latest = React.useRef(execution);
  latest.current = execution;
  React.useEffect(() => {
    if (!read || record?.snapshot) return;
    let current = true;
    void latest.current.executeValue('account.public_profile.preview', {
      policy: record?.policy ?? DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadataSelection: {},
      query: record?.query ?? DEFAULT_PUBLIC_PROFILE_QUERY, layout: { v: 1, items: [] },
      appearance: { atmosphere: { source: 'none' }, theme: 'auto' },
    }).then(value => {
      if (!current) return;
      const result = PublicProfilePreviewResultV1Schema.parse(value);
      if (result.kind === 'ready') setLocal(result.view.snapshot);
      else setFailed(true);
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [read, record]);
  const snapshot = record?.snapshot ?? local;
  const usage = usePublicProfileUsageHost(props.scope.serverId, snapshot?.period ?? null);
  const preview = React.useMemo(() => read && snapshot ? {
    source: { context: read.context, snapshot, policy: record?.policy ?? DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      metadata: record?.metadata ?? {}, appearance: { atmosphere: { source: 'none' as const }, theme: 'auto' as const } },
    labels: publicProfilePageLabels(read.context, snapshot, null), usage,
  } : null, [read, snapshot, record, usage]);
  if (!preview) return <SurfaceStateCard kind={failed || state.kind === 'failed' ? 'unavailable' : 'loading'}
    title={t('publicIdentity.editor.preparing')} reason={failed ? t('publicIdentity.page.blockUnavailable') : undefined} />;
  return <PublicProfileWidgetPreviewContext.Provider value={preview}>{props.children}</PublicProfileWidgetPreviewContext.Provider>;
}

/** Public-area mounts can draw only an admitted inert template/shared body, never the private renderer. */
export function PublicProfileWidgetSurface(props: Readonly<{
  instance: WidgetInstanceV1; descriptor: WidgetCandidate | null; size?: WidgetSizeV1; testID: string;
}>) {
  const preview = React.useContext(PublicProfileWidgetPreviewContext);
  const presentation = props.descriptor && resolveWidgetPublicSnapshotPresentationV1(props.instance, props.descriptor);
  const size = props.size ?? props.descriptor?.sizeDeclaration.defaultSize;
  const view = preview && presentation && size ? projectPublicProfilePreview({ ...preview.source,
    layout: { v: 1, items: [{ kind: 'widget', id: props.instance.id, size, frameStyle: 'plain', presentation }] },
  }) : null;
  if (!view || !preview) return <SurfaceStateCard testID={props.testID} kind="unavailable" title={t('publicIdentity.page.blockUnavailable')} />;
  return <CorePluginUiPresentationScope><HappierPublicProfileWidget view={view} widgetId={props.instance.id}
    labels={preview.labels} usage={preview.usage} testID={props.testID} /></CorePluginUiPresentationScope>;
}
