import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { SessionViewerMachineMark } from './SessionViewerMachineMark';

describe('viewer Machine mark', () => {
    it('keeps the Machine name without claiming presence until a verdict is known', async () => {
        const screen = await renderScreen(<SessionViewerMachineMark name="Build box" />);
        expect(screen.getTextContent()).toContain('Build box');
        expect(screen.findAllByType(StatusDot)).toHaveLength(0);
        await screen.update(<SessionViewerMachineMark name="Build box" online={null} />);
        expect(screen.findAllByType(StatusDot)).toHaveLength(0);
        await screen.update(<SessionViewerMachineMark name="Build box" online={true} />);
        expect(screen.findAllByType(StatusDot)).toHaveLength(1);
        await screen.update(<SessionViewerMachineMark name="Build box" online={false} />);
        expect(screen.findAllByType(StatusDot)).toHaveLength(1);
    });
});
