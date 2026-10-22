import { defineUiSurface } from '@happier-dev/plugin-ui';
export { publicSnapshotTemplate } from './publicWidget.js';
import { UsageCrew, UsageDailyChart, UsageWeekTide, type UsageWeekHourModel } from '@happier-dev/plugin-ui/components';

// Deliberately unrelated to coding-agent Usage: public finite encodings have no Happier query dependency.
const model: UsageWeekHourModel = { encoding: 'amount', grid: Array.from({ length: 7 }, (_, day) =>
  Array.from({ length: 24 }, (_, hour) => day === 0 && hour === 9 ? 42 : null)) };

export const renderSurface = defineUiSurface(() => <>
  <UsageDailyChart gap={12} testID="external-harvest-daily" chart={{ label: 'Harvest by day', size: 'tile', width: 400,
    valuesLabel: 'Harvest observations', valuesCollapseLabel: 'Hide observations', valueFormatter: value => `${value} vegetables`,
    series: [{ id: 'harvest', label: 'Vegetables', points: [{ id: 'monday', x: 'Monday', y: 42 }, { id: 'tuesday', x: 'Tuesday', y: null }] }] }} />
  <UsageCrew width={400} paint={{ accent: '#078080', paper: '#ffffff', dark: false }} label="Garden harvest"
    agents={[{ id: 'tomatoes', name: 'Tomatoes', color: '#d62a35' }, { id: 'peas', name: 'Peas', color: '#358b42' }]}
    model={[{ agentId: 'tomatoes', share: 0.75 }, { agentId: 'peas', share: null }]}
    labels={{ percent: value => `${value * 100}%`, days: value => `${value} harvest days`, unknownAgent: 'Unlabelled bed' }} testID="external-harvest" />
  <UsageWeekTide width={400} paint={{ accent: '#078080', paper: '#ffffff', dark: false }} label="Harvest by hour"
    model={model} labels={{ weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], clock: hour => `${hour}:00`,
      peak: (day, hour, value) => `Day ${day} ${hour}:00 · ${value} vegetables`,
      values: { show: 'Exact harvest', hide: 'Hide harvest', weekdayColumn: 'Day', formatValue: value => `${value} vegetables`,
        levelNames: ['None', 'Few', 'Some', 'Many', 'Most'] } }}
    testID="external-harvest-hours" />
</>);
