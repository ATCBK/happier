import * as React from 'react';
import { act } from 'react-test-renderer';

import { renderScreen, type RenderScreenResult } from './renderScreen';

const HARNESS_TEST_ID = 'collection-layout-harness';

export type CollectionLayoutHarnessMode = 'split' | 'stacked' | 'measuring' | null;

/**
 * Renders a page as the detail of a real Collection split geometry and measures it, so the page reads
 * the layout mode from its one owner (`useHappierCollectionLayout`). `split` measures a width where
 * both panes fit, `stacked` one where they do not, `measuring` leaves it unmeasured, and `null`
 * renders the page outside any Collection.
 */
export async function renderInCollectionLayout(
    element: React.ReactElement,
    mode: CollectionLayoutHarnessMode,
    /** The measured width of a `split` container (default: one where the detail pane clears a wide column). */
    splitWidthPx = 1200,
): Promise<RenderScreenResult> {
    if (mode === null) return renderScreen(element);
    // The presentation barrel includes Action fields and their SDK/catalog.
    // Only suites actually mounting a Collection need to load that graph.
    const { HappierListDetailLayout } = await import('@happier-dev/plugin-ui/presentation');
    const screen = await renderScreen(
        <HappierListDetailLayout
            testID={HARNESS_TEST_ID}
            list={null}
            detail={element}
            detailActive
            minListWidth={272}
            minDetailWidth={480}
            preferredListRatio={0}
        />,
    );
    if (mode === 'measuring') return screen;
    const container = screen.root.findAll((node) => (
        node.props.testID === HARNESS_TEST_ID && typeof node.props.onLayout === 'function'
    ))[0];
    if (!container) throw new Error('renderInCollectionLayout: the split geometry did not mount its measured container.');
    await act(async () => {
        (container.props.onLayout as (event: unknown) => void)({
            nativeEvent: { layout: { x: 0, y: 0, width: mode === 'split' ? splitWidthPx : 390, height: 800 } },
        });
    });
    return screen;
}

/**
 * Measures every mounted Collection stage, as the platform does on its first layout: a Collection lays its grid
 * out only at a width it has measured (a phone never flashes a desktop grid), and a test renderer never lays out.
 */
export async function measureMountedCollections(
    screen: RenderScreenResult,
    size: Readonly<{ width: number; height?: number }> = { width: 1200 },
): Promise<void> {
    const stages = screen.root.findAll((node) => (
        typeof node.props.testID === 'string'
        && node.props.testID.endsWith(':stage')
        && typeof node.props.onLayout === 'function'
    ));
    await act(async () => {
        for (const stage of stages) {
            (stage.props.onLayout as (event: unknown) => void)({
                nativeEvent: { layout: { x: 0, y: 0, width: size.width, height: size.height ?? 800 } },
            });
        }
    });
}
