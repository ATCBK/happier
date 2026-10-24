import { getWidgetSizeFootprintV1, WIDGET_SIZE_POLICY_V1,
  type WidgetSizeV1, type WidgetSurfaceRefV1 } from '@happier-dev/plugin-sdk/ui';
import type { WidgetGroupCellInput, WidgetGroupContentState } from '../presentation/layout/widgetGroupLayout.js';
export { packWidgetGroupBands, resolveWidgetGroupColumns } from '../presentation/layout/widgetGroupLayout.js';

/** Empty half cells need only the existing compact row; saved geometry stays untouched. */
export function projectWidgetGroupCellContent(
  cell: WidgetGroupCellInput,
  contentState: WidgetGroupContentState | undefined,
): WidgetGroupCellInput {
  const compactRowSpan = WIDGET_SIZE_POLICY_V1.home.footprints.small.rowSpan;
  return contentState === 'empty' && cell.columnSpan === 1 && cell.rowSpan > compactRowSpan
    ? { ...cell, rowSpan: compactRowSpan }
    : cell;
}

/** The surface's A3 footprint for each child, in the group's reading order. */
export function resolveWidgetGroupCells(
  surface: WidgetSurfaceRefV1['owner']['kind'],
  children: readonly Readonly<{ id: string; size: WidgetSizeV1 | undefined; contentState?: WidgetGroupContentState }>[],
): WidgetGroupCellInput[] {
  return children.map((child) => {
    const footprint = child.size
      ? getWidgetSizeFootprintV1(surface, child.size)
      : undefined;
    return projectWidgetGroupCellContent({
      id: child.id,
      columnSpan: footprint?.columnSpan ?? 1,
      rowSpan: footprint?.rowSpan ?? 2,
    }, child.contentState);
  });
}
