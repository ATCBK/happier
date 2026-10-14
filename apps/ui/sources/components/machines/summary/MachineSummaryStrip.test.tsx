import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';

import { renderScreen } from '@/dev/testkit';

import { MachineSummaryStrip } from './MachineSummaryStrip';
import { MACHINE_SUMMARY_PREVIEW } from './machineSummaryPreview';

describe('MachineSummaryStrip', () => {
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

    it('leaves a list row\'s name its width: on the name\'s line one instrument stands, chosen metrics beyond it yield', async () => {
        const screen = await renderScreen(<MachineSummaryStrip testID="strip" availability={MACHINE_SUMMARY_PREVIEW.calm} style="bars" metrics={['cpu', 'memory', 'disk']} layout="inline" />);
        const label = String(screen.findByTestId('strip')?.props.accessibilityLabel);
        expect(label).toContain('4%');
        expect(label).not.toContain('19 GB');
        expect(label).not.toContain('310 GB');
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
