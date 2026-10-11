import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));

vi.mock('react-native-svg', async (importOriginal) => ({
    ...(await importOriginal<typeof import('react-native-svg')>()),
    SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
}));

import { ProviderIcon } from './ProviderIcon';

describe('ProviderIcon', () => {
    it('uses a contributed installed icon token and fails safely to the generic provider icon', async () => {
        const contributed = await renderScreen(<ProviderIcon icon="sparkle" size={29} color="black" />);
        expect(contributed.findByType('Icon').props.name).toBe('sparkle');
        const fallback = await renderScreen(<ProviderIcon icon="https://remote.example/icon.svg" size={29} color="black" />);
        expect(fallback.findByType('Icon').props.name).toBe('cube');
    });

    it('draws a bundled provider brand mark in the requested ink instead of the neutral cube', async () => {
        const mark = await renderScreen(<ProviderIcon icon="deepseek" size={24} color="#123456" />);
        expect(mark.findAllByType('Icon')).toHaveLength(0);
        const svg = mark.findByType('SvgXml');
        expect(svg.props.xml).toContain('fill="#123456"');
        expect(svg.props.width).toBe(24);
        const strokeMark = await renderScreen(<ProviderIcon icon="openrouter" size={24} color="#123456" />);
        expect(strokeMark.findByType('SvgXml').props.xml).toContain('stroke="#123456"');
    });
});
