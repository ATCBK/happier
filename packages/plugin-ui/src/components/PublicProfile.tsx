import { useMemo, type ComponentProps } from 'react';
import {
  HappierPublicProfile as ProfilePresentation,
  HappierPublicProfileWidget as WidgetPresentation,
  type HappierPublicProfileProps as PresentationProps,
  type PublicProfileProjection,
} from '../presentation/account/PublicProfile.js';
import type { PublicProfileInputView } from './publicProfileTypes.js';
import type { HappierPublicProfileUsageHost } from '../presentation/account/PublicProfileUsage.js';
import { renderInertDeclarativeView } from '../declarative/inertDeclarativeView.js';
import { projectPublicUsageChartModels, projectPublicUsageRecords } from '../data/publicUsageChartModels.js';
import { resolveWidgetGroupCells } from '../data/widgetGroupLayout.js';
export { HAPPIER_PUBLIC_PROFILE_HERO_METRICS } from '../presentation/layout/pageMetrics.js';
export type { HappierPublicProfileHeroGeometry, HappierPublicProfileLabels, HappierPublicProfileOwner } from '../presentation/account/PublicProfile.js';
export type { HappierPublicProfileUsageHost, HappierPublicProfileUsageLabels } from '../presentation/account/PublicProfileUsage.js';

type PublishedProps = Omit<Extract<PresentationProps, { view: unknown }>, 'view' | 'projection'> & Readonly<{ view: PublicProfileInputView }>;
export type HappierPublicProfileProps = PublishedProps | Extract<PresentationProps, { result: unknown }>;

function usePublicProfileProjection(view: PublicProfileInputView, usage: HappierPublicProfileUsageHost | undefined): PublicProfileProjection {
  const models = useMemo(() => view.snapshot ? projectPublicUsageChartModels(view.snapshot, view.metadata) : null,
    [view.snapshot, view.metadata]);
  const format = usage?.labels.records?.format;
  const records = useMemo(() => format && view.snapshot ? projectPublicUsageRecords(view.snapshot, format) : null,
    [view.snapshot, format]);
  const cells = new Map(resolveWidgetGroupCells('corePage', view.layout.items.flatMap(item =>
    item.kind === 'widget' ? [item] : [{ id: item.id, size: undefined }, ...item.children])).map(cell => [cell.id, cell]));
  return { models, records, cells, renderDeclarative: renderInertDeclarativeView };
}

function PublishedPublicProfile(props: PublishedProps) {
  const projection = usePublicProfileProjection(props.view, props.usage);
  return <ProfilePresentation {...props} projection={projection} />;
}

/** SDK DTO projection stays in the adapter; all page markup has one shared owner. */
export function HappierPublicProfile(props: HappierPublicProfileProps) {
  return 'result' in props ? <ProfilePresentation {...props} /> : <PublishedPublicProfile {...props} />;
}

export function HappierPublicProfileWidget(props: Omit<ComponentProps<typeof WidgetPresentation>, 'view' | 'projection'> & Readonly<{ view: PublicProfileInputView }>) {
  const projection = usePublicProfileProjection(props.view, props.usage);
  return <WidgetPresentation {...props} projection={projection} />;
}
