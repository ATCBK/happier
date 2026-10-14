/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';

vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsRealModule());
vi.mock('@/utils/web/reactDomCjs', async () => {
    const dom = await import('react-dom');
    return { requireReactDOM: () => dom };
});

import { WidgetFrame } from './WidgetFrame';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('hands a web widget its measured room in the first commit, before any layout event can reach it', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 0, width: 429, height: 307, top: 0, left: 0, right: 429, bottom: 307, toJSON: () => ({}),
    });
    const widths: Array<number | undefined> = [];
    function Body() {
        widths.push(useWidgetPresentation()?.geometry?.width);
        return <>laid out from its width</>;
    }
    try {
        // A jsdom page fires no layout events: only the frame's own first-commit read can tell the body its width.
        await act(async () => root.render(<WidgetFrame testID="measured" frameStyle="card" grouped placement="home" title="Capacity"
            widgetPresentation={{ size: 'small', footprint: { columns: 2, columnSpan: 1, rowSpan: 2, height: 'regular', width: 'half' } }}
            body={{ kind: 'content', children: <Body /> }} />));
        expect(widths.at(-1)).toBe(429);
    } finally {
        measure.mockRestore();
        await act(async () => root.unmount());
        container.remove();
    }
});
