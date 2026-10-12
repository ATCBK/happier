export * from './Action.js';
export { ApprovalPrompt, type ApprovalPromptProps } from './ApprovalPrompt.js';
export * from './Button.js';
export * from './Collection.js';
export type { CollectionVirtualizer, CollectionVirtualizerHandle, CollectionVirtualizerRequest } from '../presentation/collection/collectionVirtualizer.js';
export * from './Content.js';
export { Chart, DataRows, DataTable, Metric, type ChartProps, type DataRowsProps, type MetricProps } from './Data.js';
export {
  AgentCursor,
  PresenceCapsule,
  StatusCapsule,
  type AgentCursorProps,
  type PresenceCapsuleProps,
  type StatusCapsuleProps,
} from './Copresence.js';
export { Avatar, type AvatarProps } from './Avatar.js';
export { DetailsPane, DetailsPaneFooter, type DetailsPaneProps } from './DetailsPane.js';
export { DiffStat, type DiffStatProps } from './DiffStat.js';
export { PaneHeaderContent, type PaneHeaderContentProps, type PaneHeaderContentLineSegment } from './PaneHeaderContent.js';
export {
  type PluginUiFocusTarget,
  usePluginUiFocusTarget,
} from './Focus.js';
export * from './Foundation.js';
export * from './Form.js';
export { Icon, type IconName, type IconProps } from './Icon.js';
export * from './Image.js';
export { MotionFeedback, type MotionFeedbackProps } from './MotionFeedback.js';
export * from './StoredImage.js';
export * from './Layout.js';
export { LinkDelivery, type LinkDeliveryProps } from './LinkDelivery.js';
export {
  SettingRow, SettingStatusLine, SettingValueSlot,
  type SettingRowLayout, type SettingRowProps, type SettingStatusLineProps, type SettingValueSlotProps,
} from './Setting.js';
export {
  List, Item, ItemGroup,
  type ListSearchProps, type ListMultiSelectionCapabilityProps, type ListSingleChoiceCapabilityProps, type ListSelectionProps,
  type ListHeaderContext, type ListSectionData, type ListProps, type ListSectionProps,
  type ItemProps, type ListItemProps, type ListAccessibilityPattern, type ItemGroupProps,
} from './List.js';
export { CountedDisclosureItem, type CountedDisclosureItemProps } from './CountedDisclosureItem.js';
export * from './NavigationList.js';
export * from './PageHeader.js';
export {
  createListMultiSelectionStore, useListMultiSelectionController,
  ListMultiSelectionProvider, useOptionalListMultiSelectionStore,
  useListMultiSelectionStoreSnapshot, useListMultiSelectionSnapshot, useListMultiSelectionRow,
  ListSelectionActionBar,
  type ListMultiSelectionKey, type ListMultiSelectionSnapshot, type ListMultiSelectionActions,
  type ListMultiSelectionStore, type UseListMultiSelectionControllerInput,
  type ListMultiSelectionProviderProps, type ListMultiSelectionRow,
  type ListBulkAction, type ListSelectionActionBarProps,
} from './ListMultiSelection.js';
export * from './Overlay.js';
export {
  usePluginAccessibility,
  usePluginTheme,
  usePluginTranslation,
  useSurfaceContext,
  type PluginAccessibilityFacts,
  type PluginTranslate,
  type PluginTranslationValues,
} from './PluginUiProvider.js';
export * from './SelectionTiles.js';
export * from './Session.js';
export * from './Spinner.js';
export * from './State.js';
export * from './Status.js';
export * from './Step.js';
export * from './Setup.js';
export * from './Voice.js';
export * from './Surface.js';
export * from './Tabs.js';
export { Timeline, type TimelineProps, type TimelineItemContent } from './Timeline.js';
export * from './Text.js';
export * from './TargetedSurface.js';
export { WidgetSurface, type WidgetSurfaceProps } from './WidgetSurface.js';
export { WidgetFrame, type WidgetFrameProps } from './WidgetFrame.js';
export { WidgetGlanceRow, type WidgetGlanceRowProps } from './WidgetGlanceRow.js';
export { FloatingFrame, type FloatingFrameProps } from './FloatingFrame.js';
export { Tree, type TreeItem, type TreeProps } from './Tree.js';
export { DragSource, DropTarget, type DragSourceProps, type DropTargetProps } from './EntityDragDrop.js';
export {
  WidgetPresentationProvider,
  useWidgetPresentation,
  type WidgetPresentation,
  type WidgetPresentationProviderProps,
} from './WidgetPresentation.js';

// Neutral owners consumed by the migrated public author fixtures. The author
// adapters above remain distinct from the shared controlled presentation.
export {
  FloatingFrame as HappierFloatingFrame,
  type FloatingFrameProps as HappierFloatingFrameProps,
} from '../presentation/layout/FloatingFrame.js';
export { resolveFloatingFrameRect, type FrameRect } from '../presentation/layout/floatingFrameGeometry.js';
export { HappierStack } from '../presentation/layout/Layout.js';
export { HappierText } from '../presentation/text/Text.js';
export { resolveHappierTreeFocusKey, type HappierTreeNode } from '../presentation/navigation/treeInteraction.js';
export { useHappierCollection } from '../presentation/collection/useCollection.js';
export type { HappierCollectionPresentation } from '../presentation/collection/collectionTable.js';
export { HappierDisclosure } from '../presentation/collection/Disclosure.js';
export { HAPPIER_INSTANT_DISCLOSURE_MOTION } from '../presentation/collection/collectionMotion.js';
export { HappierPressable } from '../presentation/interaction/Pressable.js';
export { HappierStateLine } from '../presentation/state/InfoState.js';
export { StackedSeriesChart, type StackedSeriesBand } from '../presentation/data/StackedSeriesChart.js';
export { Heatmap } from '../presentation/data/Heatmap.js';
export { DotGrid } from '../presentation/data/DotGrid.js';
export { IntervalTimeline } from '../presentation/data/IntervalTimeline.js';
export { CapacityBar } from '../presentation/data/CapacityBar.js';
export { BurnUpChart } from '../presentation/data/BurnUpChart.js';
export { RankedRows } from '../presentation/data/RankedRows.js';
export { CompositionStrip } from '../presentation/data/CompositionStrip.js';
export { OutcomeScatter } from '../presentation/data/OutcomeScatter.js';
export { OutcomeFunnel } from '../presentation/data/OutcomeFunnel.js';
export { CoreLoadBars } from '../presentation/data/CoreLoadBars.js';
export { Sunburst } from '../presentation/data/Sunburst.js';
export { Treemap, type HappierChartPart } from '../presentation/data/Treemap.js';
export { layoutHappierTreemap, squarifyHappierTreemap, createHappierTreemapHitGrid } from '../presentation/data/treemapLayout.js';
export { layoutHappierSunburst, hitHappierSunburst } from '../presentation/data/sunburstLayout.js';
