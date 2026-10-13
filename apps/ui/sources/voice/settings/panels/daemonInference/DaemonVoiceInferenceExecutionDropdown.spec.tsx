import React from 'react';

import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';

afterEach(standardCleanup);

describe('DaemonVoiceInferenceExecutionDropdown', () => {
    it('hides device selection when the surface clamps web execution', async () => {
        const setExecution = vi.fn();
        const { DaemonVoiceInferenceExecutionDropdown } = await import('./DaemonVoiceInferenceExecutionDropdown');

        const { tree } = await renderScreen(
            React.createElement(DaemonVoiceInferenceExecutionDropdown, {
                execution: 'device',
                allowDeviceSelection: false,
                setExecution,
                popoverBoundaryRef: null,
            }),
        );

        const dropdown = tree.root.findByType(DropdownMenu);
        expect(dropdown.props.selectedId).toBe('daemon');
        expect(dropdown.props.items.map((item: { id: string }) => item.id)).toEqual(['auto', 'daemon']);
        expect(dropdown.props.itemTrigger.detailFormatter()).toBe(
            dropdown.props.items.find((item: { id: string }) => item.id === 'daemon')?.title,
        );

        await act(async () => { dropdown.props.onSelect('device'); });

        expect(setExecution).toHaveBeenCalledWith('daemon');
    });
});
