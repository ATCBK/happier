import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/layout/layout', () => ({
    useLayoutMaxWidth: () => 850,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

// Collect the real component graph once; cases only vary rendered props.
await import('./ItemGroup');
await import('./SectionContentRow');
await import('./listPresentation');

afterEach(() => {
    standardCleanup();
});

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function rowStyle(screen: Screen, testID: string) {
    const node = screen.findAll((candidate) => typeof candidate.type === 'string' && candidate.props.testID === testID)[0];
    if (!node) throw new Error(`Missing row ${testID}`);
    return flattenTestStyle(node.props.style);
}

// The divider is the row's bottom rule; the test stylesheet has no hairline width, so its colour marks it.
function hasDivider(style: Record<string, unknown>): boolean {
    return style.borderBottomColor !== undefined;
}

describe('SectionContentRow', () => {
    it('divides free content from the next row like an Item does, and not after the last row of the section', async () => {
        const { ItemGroup } = await import('./ItemGroup');
        const { SectionContentRow } = await import('./SectionContentRow');
        const { ListPresentationProvider } = await import('./listPresentation');
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Density">
                    <SectionContentRow testID="first">{React.createElement('Text', null, 'Tiles')}</SectionContentRow>
                    <SectionContentRow testID="last">{React.createElement('Text', null, 'Preview')}</SectionContentRow>
                </ItemGroup>
            </ListPresentationProvider>,
        );

        expect(hasDivider(rowStyle(screen, 'first'))).toBe(true);
        expect(hasDivider(rowStyle(screen, 'last'))).toBe(false);
    });

    it('sits directly under the row it continues instead of opening a new row', async () => {
        const { SectionContentRow } = await import('./SectionContentRow');
        const screen = await renderScreen(
            <>
                <SectionContentRow testID="own">{React.createElement('Text', null, 'Tiles')}</SectionContentRow>
                <SectionContentRow testID="continues" continuesRow>{React.createElement('Text', null, 'Preview')}</SectionContentRow>
            </>,
        );

        const own = rowStyle(screen, 'own');
        const continues = rowStyle(screen, 'continues');
        expect(Number(own.paddingTop)).toBeGreaterThan(0);
        expect(continues.paddingTop).toBe(0);
        // It keeps the row's horizontal inset, so its content lines up with the row above.
        expect(continues.paddingHorizontal).toBe(own.paddingHorizontal);
    });
});
