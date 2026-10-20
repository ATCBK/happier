import * as React from 'react';

import type { WidgetAreaLayout } from '@/components/widgets/area/useWidgetAreaLayout';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { t } from '@/text';

import {
  mergeProjectOverviewWidgetHeads,
  projectOverviewWidgetAreas,
  readProjectOverviewWidgetAreas,
} from './projectOverviewPlacements';

type AreaLayout = WidgetAreaLayout<WidgetSurfaceContext>;

/**
 * One Project layout document as each of its areas draws it: the saved sequence, or the render-only
 * defaults where an area is missing (plan 12 §2), plus the phone's merged column. Overview and the Code
 * aside's Widgets block read the same document through this one projection, so both show the same side area.
 */
export function useProjectOverviewAreaLayouts(layout: AreaLayout): Readonly<{
  ready: boolean;
  main: AreaLayout;
  aside: AreaLayout;
  phone: AreaLayout;
}> {
  const rawAreas = React.useMemo(
    () =>
      layout.state.status === 'ready'
        ? readProjectOverviewWidgetAreas(
            layout.state.documentState === 'missing'
              ? null
              : {
                  v: 1,
                  surface: layout.state.surface,
                  instances: layout.state.placements,
                },
          )
        : null,
    [layout.state],
  );
  return React.useMemo(() => {
    const areas = rawAreas ? projectOverviewWidgetAreas(rawAreas) : null;
    const merged = rawAreas ? mergeProjectOverviewWidgetHeads(rawAreas) : null;
    const project = (
      placements: readonly NonNullable<typeof merged>[number][] | null,
    ): AreaLayout => ({
      ...layout,
      state:
        layout.state.status === 'ready' && placements
          ? { ...layout.state, placements: [...placements] }
          : layout.state,
    });
    return {
      ready: areas !== null,
      main: project(areas?.main ?? null),
      aside: project(areas?.aside ?? null),
      phone: project(merged),
    };
  }, [layout, rawAreas]);
}

/** A Project area's dashboard words: its quiet Add line, where the gallery says the widget goes, and its emptied line. */
export function projectOverviewAreaDashboard(
  layout: AreaLayout,
  area: 'main' | 'aside',
): Readonly<{
  addLabel: string;
  addTitle: string;
  emptyTitle: string;
}> {
  return {
    addLabel: t('projects.widgets.add'),
    addTitle: t('projects.widgets.addTo', {
      dashboard:
        layout.state.status === 'ready'
          ? (layout.state.dashboard?.name ?? t('projects.pages.overview'))
          : t('projects.pages.overview'),
      area: t(
        area === 'main'
          ? 'projects.widgets.mainArea'
          : 'projects.widgets.sideArea',
      ),
    }),
    emptyTitle: t('projects.widgets.emptyArea'),
  };
}
