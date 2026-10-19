import React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks({
    reactNative: () => createReactNativeWebMock({ Platform: { OS: 'ios' } }),
});

describe('MarkdownView inline references (native)', () => {
    it('draws a severity citation in the prose ink where the package can only colour links, and keeps other links in the link colour', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const reference = (severity?: 'high') => ({
            scheme: 'finding',
            resolve: (target: string) => (target === 'f1'
                ? { label: 'High · Codex', ...(severity ? { severity } : {}), foreground: '#c00', background: '#fee' }
                : null),
        });
        const markdown = 'A case stays open [the sheet](finding:f1) and see [docs](https://example.com).';
        const styleOf = async (severity?: 'high') => (await renderScreen(
            <MarkdownView markdown={markdown} inlineReferences={reference(severity)} />,
        )).findAllByType('EnrichedMarkdownText')[0]!.props.markdownStyle;
        const withSeverity = await styleOf('high');
        const withoutSeverity = await styleOf();
        expect(withSeverity.link.color).toBe(withSeverity.paragraph.color);
        expect(withoutSeverity.link.color).not.toBe(withoutSeverity.paragraph.color);
    });
});
