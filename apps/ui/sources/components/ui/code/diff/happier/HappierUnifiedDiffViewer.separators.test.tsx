import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key, params) => (key === 'hunkReview.unchangedLines' ? `${(params as { count: number }).count} unchanged lines` : key),
}));

const codeLinesViewType = Reflect.get(CodeLinesView, 'type') ?? CodeLinesView;
const PATCH = ['@@ -18,3 +19,4 @@ export function SettingsModal()', '   const { width } = useWindowDimensions();',
    '-  const key = `${route.path}:${width}`;', '+  const key = useSettingsRouteKey(route);', '+  // keyed by route', '   return (', ''].join('\n');

async function headerLines(props: Readonly<{ lineInfoSeparators?: boolean }>): Promise<readonly CodeLine[]> {
    const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');
    const screen = await renderScreen(<HappierUnifiedDiffViewer virtualized={false} mode="unified" unifiedDiff={PATCH} {...props} />);
    const lines: readonly CodeLine[] = screen.findAllByType(codeLinesViewType)[0]!.props.lines;
    return lines.filter((line) => line.renderIsHeaderLine);
}

describe('HappierUnifiedDiffViewer hunk separators', () => {
    afterEach(() => standardCleanup());

    it('stands in for Pierre with its quiet "N unchanged lines" band instead of the raw @@ header', async () => {
        const [separator] = await headerLines({ lineInfoSeparators: true });
        expect(separator?.renderCodeText).toBe('18 unchanged lines  export function SettingsModal()');
        expect(separator?.renderIsSeparatorLine).toBe(true);
    });

    it('keeps the raw header where no separator presentation is asked for', async () => {
        const [header] = await headerLines({});
        expect(header?.renderCodeText.startsWith('@@ -18,3 +19,4 @@')).toBe(true);
        expect(header?.renderIsSeparatorLine).toBeUndefined();
    });
});
