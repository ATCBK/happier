import { useState } from 'react';
import { Button, defineUiSurface, Stack, Text, usePluginAccessibility, usePluginTheme } from '@happier-dev/plugin-ui';
import {
  CapacityBar, CoreLoadBars, HappierStateLine, StackedSeriesChart, Sunburst, Treemap,
  type HappierChartPart,
} from '@happier-dev/plugin-ui/components';

const parts = [
  { key: 'projects', label: 'Projects', value: 60, valueLabel: '60 GB', tone: 'accent' },
  { key: 'archives', label: 'Archives', value: 40, valueLabel: '40 GB', tone: 'ink', hatched: true },
] as const satisfies readonly HappierChartPart[];
const smallerLabel = (count: number) => `${count} smaller items`;

/** Public-only author example: observed inputs, exact text and shared keyboard selection. */
function ChartFamilyPanel() {
  const theme = usePluginTheme();
  const { reducedMotion } = usePluginAccessibility();
  const [opened, setOpened] = useState<string | null>(null);
  const [valuesExpanded, setValuesExpanded] = useState(false);
  return <Stack>
    <Text value="Storage breakdown" />
    {parts.map((part) => <Button key={part.key} variant="plain" title={`Open ${part.label}, ${part.valueLabel}`}
      onPress={() => setOpened(`List: ${part.key}`)} />)}
    <Treemap theme={theme} items={parts} width={400} height={240} minNodePx={{ width: 56, height: 20 }}
      accessibilityLabel="Storage map" smallerLabel={smallerLabel} onOpen={(key) => setOpened(`Map: ${key}`)} reducedMotion={reducedMotion} testID="author-treemap" />
    <Sunburst theme={theme} items={parts} width={400} height={408} minArcDegrees={2} centerLabel="Storage" centerValue="100 GB"
      accessibilityLabel="Storage rings" smallerLabel={smallerLabel} onOpen={(key) => setOpened(`Rings: ${key}`)} reducedMotion={reducedMotion} testID="author-sunburst" />
    <StackedSeriesChart theme={theme} label="CPU history" variant="line" size="full" width={400}
      series={[{ id: 'cpu', label: 'CPU', points: [{ id: 'first', x: '09:00', y: 20 }, { id: 'second', x: '09:01', y: 40 }] }]}
      valuesExpanded={valuesExpanded} onValuesExpandedChange={setValuesExpanded}
      summary="CPU rose from 20 to 40 percent" valueFormatter={(value) => `${value}%`} reducedMotion={reducedMotion} testID="author-series" />
    <CapacityBar theme={theme} label="Storage in use" value={100} capacity={200} basis="GB" animated reducedMotion={reducedMotion} testID="author-capacity" />
    <CoreLoadBars theme={theme} label="CPU cores" width={400} cores={[{ index: 0, busyPct: 40 }, { index: 1, busyPct: null }]}
      coreLabel={(core) => `Core ${core.index + 1}, ${core.busyPct === null ? 'not reported' : `${core.busyPct}% in use`}`} testID="author-cores" />
    <HappierStateLine accessibilitySemantics="status" testID="author-state-line">
      <Text value={opened ? `Opened ${opened}` : 'Select a storage part'} />
    </HappierStateLine>
  </Stack>;
}

export const renderSurface = defineUiSurface(ChartFamilyPanel);
