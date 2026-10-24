import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { MachineResourceSummaryV1Schema, projectMachineResourceSummaryV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { MachineVitalsSnapshotV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';

import { renderScreen } from '@/dev/testkit';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { t } from '@/text';

import { MachineSummaryStrip } from './MachineSummaryStrip';
import { MACHINE_SUMMARY_METRICS } from './machineSummaryStripModel';
import { MACHINE_SUMMARY_PREVIEW } from './machineSummaryPreview';

describe('MachineSummaryStrip', () => {
    it.each([
        { layout: 'under', source: 'kernel_level', key: 'kernel' },
        { layout: 'inline', source: 'psi', key: 'estimated' },
        { layout: 'cells', source: 'events', key: 'estimated' },
        { layout: 'fact', source: 'none', key: 'none' },
        { layout: 'tiles', source: 'kernel_level', key: 'kernel' },
    ] as const)('carries producer pressure provenance into $layout hover and accessible text', async ({ layout, source, key }) => {
        const snapshot = MachineVitalsSnapshotV1Schema.parse({
            state: 'reporting', sample: { v: 1, sampledAt: 60_000, intervalMs: 15_000,
                cpu: { reported: false, reason: 'unavailable' },
                memory: { reported: true, totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3, usedBytes: 2 * 1024 ** 3,
                    pressure: { level: source === 'none' ? 'not_reported' : 'calm', source } },
                disk: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' } },
            series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
        });
        const summary = MachineResourceSummaryV1Schema.parse(projectMachineResourceSummaryV1(snapshot));
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={{ kind: 'reporting', summary, freshness: 'live' }}
            style="bars" metrics={['memory']} layout={layout} />);
        const provenance = t(`machineVitals.memory.source.${key}`);
        expect(screen.findByTestId('strip')?.props.accessibilityLabel).toContain(provenance);
        expect(screen.findAll(node => node.type === Tooltip).some(node => String(node.props.label).includes(provenance))).toBe(true);
    });
    it('draws nothing with no metric shown: rows show the machine name only (R42.6)', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={MACHINE_SUMMARY_PREVIEW.calm} style="sparklines" metrics={[]} layout="under" />);
        // The component itself carries the id; no host view is drawn for it.
        expect(screen.findAll(node => typeof node.type === 'string' && node.props?.testID === 'strip')).toHaveLength(0);
    });

    it('names every shown metric exactly for screen readers, in use for CPU and free for memory and disk', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={MACHINE_SUMMARY_PREVIEW.calm} style="bars" metrics={['cpu', 'memory', 'disk']} layout="under" />);
        const label = String(screen.findByTestId('strip')?.props.accessibilityLabel);
        expect(label).toContain('4%');
        expect(label).toContain('19 GB');
        expect(label).toContain('310 GB');
    });

    it('draws every chosen instrument on the name\'s line in a list row (lab `rm` R): three small lines, no figures', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={MACHINE_SUMMARY_PREVIEW.calm} style="sparklines" metrics={['cpu', 'memory', 'disk']} layout="inline" />);
        const label = String(screen.findByTestId('strip')?.props.accessibilityLabel);
        expect(label).toContain('4%');
        expect(label).toContain('19 GB');
        expect(label).toContain('310 GB');
        expect(screen.getTextContent()).not.toContain('GB');
    });

    it('leaves a list row\'s name its width when numbers are the style: one figure stands, the metric in trouble first', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={MACHINE_SUMMARY_PREVIEW.calm} style="numbers" metrics={['cpu', 'memory', 'disk']} layout="inline" />);
        expect(screen.getTextContent()).toContain('4%');
        expect(screen.getTextContent()).not.toContain('19 GB');
        expect(screen.getTextContent()).not.toContain('310 GB');
    });

    it('steps the `under` row down to the metrics that fit its measured width, calm ones first, and back up when it widens', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={MACHINE_SUMMARY_PREVIEW.calm}
            style="bars" metrics={MACHINE_SUMMARY_METRICS} layout="under" />);
        const measure = (width: number) => act(() => screen.findByTestId('strip')!.props.onLayout({ nativeEvent: { layout: { width, height: 16, x: 0, y: 0 } } }));
        const named = () => screen.findAll(node => node.type === Tooltip).length;
        // Before the first measurement every chosen metric shows (nothing is dropped on a guess).
        expect(named()).toBe(MACHINE_SUMMARY_METRICS.length);
        measure(0);
        expect(named()).toBe(MACHINE_SUMMARY_METRICS.length);
        measure(250);
        expect(named()).toBeLessThan(MACHINE_SUMMARY_METRICS.length);
        expect(named()).toBeGreaterThanOrEqual(1);
        const retainedMetrics = named();
        measure(0);
        expect(named()).toBe(retainedMetrics);
        measure(40);
        expect(named()).toBe(1);
        measure(520);
        expect(named()).toBe(MACHINE_SUMMARY_METRICS.length);
    });

    it('keeps its slots without figures while the values are not held yet, never saying zero', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={{ kind: 'reporting', summary: null, freshness: 'live' }}
            style="numbers" metrics={['cpu', 'memory']} layout="under" />);
        expect(screen.findByTestId('strip')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('0%');
        expect(screen.getTextContent()).toContain('–');
    });

    it('labels ring-tile memory and disk amounts with their free-space units', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={MACHINE_SUMMARY_PREVIEW.calm}
            style="rings" metrics={['memory', 'disk']} layout="tiles" />);
        expect(screen.getTextContent()).toContain('GB free');
        expect(screen.findByTestId('strip')?.props.accessibilityLabel).toContain('19 GB');
        expect(screen.findByTestId('strip')?.props.accessibilityLabel).toContain('310 GB');
    });

    it('draws no line before a sample exists: an unsampled metric is never a flat zero', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={{ kind: 'reporting', summary: null, freshness: 'live' }}
            style="sparklines" metrics={['cpu', 'memory']} layout="under" />);
        expect(screen.findByTestId('strip')).not.toBeNull();
        expect(screen.findAll(node => node.type === StackedSeriesChart)).toHaveLength(0);
    });

    it('keeps summary sparklines passive while announcing their measured values', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={MACHINE_SUMMARY_PREVIEW.calm}
            style="sparklines" metrics={['cpu', 'memory']} layout="under" />);
        expect(screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'button')).toHaveLength(0);
        expect(screen.findByTestId('strip')?.props.accessibilityLabel).toContain('4%');
        expect(screen.findByTestId('strip')?.props.accessibilityLabel).toContain('19 GB');
    });

    it('dims one step when the held summary is stale', async () => {
        const stale = { ...MACHINE_SUMMARY_PREVIEW.calm, freshness: 'stale' } as const;
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={stale} style="numbers" metrics={['cpu']} layout="under" />);
        const style = [screen.findByTestId('strip')?.props.style].flat(3).filter(Boolean) as Array<{ opacity?: number }>;
        expect(style.some(entry => typeof entry.opacity === 'number' && entry.opacity < 1)).toBe(true);
    });
});
