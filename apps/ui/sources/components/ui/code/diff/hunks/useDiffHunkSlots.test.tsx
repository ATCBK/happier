import * as React from 'react';
import { expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { buildReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { useDiffHunkSlots } from './useDiffHunkSlots';
import type { DiffHunkInfo } from '../diffViewerTypes';

function StatefulRow(props: Readonly<{ hunk: DiffHunkInfo }>) {
    const [mountedKey] = React.useState(props.hunk.key);
    return <>{mountedKey}</>;
}
const renderRow = (hunk: DiffHunkInfo) => <StatefulRow hunk={hunk} />;
function SlotHarness(props: Readonly<{ unifiedDiff: string }>) {
    const slot = useDiffHunkSlots({ mode: 'unified', unifiedDiff: props.unifiedDiff, hunks: {} }, renderRow);
    const anchor = buildCodeLinesFromUnifiedDiff({ unifiedDiff: props.unifiedDiff })
        .find((line) => slot.table.hunksByAfterLineId.has(line.id));
    return <>{anchor ? slot.renderAfterLine?.(anchor) : null}</>;
}

it('keys row and note lifecycles by canonical review-unit identity', async () => {
    const patch = '@@ -1 +1 @@\n-old\n+new\n';
    const screen = await renderScreen(<SlotHarness unifiedDiff={patch} />);
    const next = patch.replace('+new', '+newer');
    await screen.update(<SlotHarness unifiedDiff={next} />);
    expect(screen.getTextContent()).toBe(buildReviewUnits('', null, next)[0]!.key);
});
