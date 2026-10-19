import type { UsageAnalyticsBreakdownDimension } from '@happier-dev/protocol';
import type { WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { t } from '@/text';

/** The words a breakdown dimension goes by, as a block heading ("By agent") and as the one dimension a card ranks. */
export const USAGE_BREAKDOWN_DIMENSION_HEADING = {
  agent: 'usage.board.page.dimensionAgent',
  model: 'usage.board.page.dimensionModel',
  session: 'usage.board.page.dimensionSession',
  project: 'usage.board.page.dimensionProject',
  workspace: 'usage.board.page.dimensionWorkspace',
  backendMode: 'usage.board.page.dimensionBackendMode',
  source: 'usage.board.page.dimensionSource',
  machine: 'usage.board.page.dimensionMachine',
} as const satisfies Record<UsageAnalyticsBreakdownDimension, string>;

const USAGE_BREAKDOWN_DIMENSION_TITLE = {
  ...USAGE_BREAKDOWN_DIMENSION_HEADING,
  agent: 'usage.board.page.filterAgents',
} as const satisfies Record<UsageAnalyticsBreakdownDimension, string>;

/**
 * A Breakdowns widget that ranks exactly one dimension is called by it ("Models", "Machines"), so two of them on
 * one page are told apart by what each ranks, and its body then draws no second heading for it. Several
 * dimensions (or the default pair) stay "Breakdowns". `null` when the widget keeps its definition's title.
 */
export function readUsageBreakdownsInstanceTitle(instance: Pick<WidgetInstanceV1, 'definition' | 'bindings'>): string | null {
  if (instance.definition.kind !== 'builtin' || instance.definition.id !== 'usage_breakdowns') return null;
  const binding = instance.bindings.breakdown;
  if (binding?.kind !== 'value' || !Array.isArray(binding.value) || binding.value.length !== 1) return null;
  const dimension = binding.value[0];
  return typeof dimension === 'string' && Object.hasOwn(USAGE_BREAKDOWN_DIMENSION_TITLE, dimension)
    ? t(USAGE_BREAKDOWN_DIMENSION_TITLE[dimension as UsageAnalyticsBreakdownDimension]) : null;
}
