// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { localizePierreSeparatorText } from './pierreSeparatorText.web';

describe('Pierre hunk separator text', () => {
    it('reads the app\'s own "N unchanged lines" string, as the Happier renderer does, and leaves other text alone', () => {
        const host = document.createElement('div');
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<div data-separator="line-info"><span data-unmodified-lines>18 unmodified lines</span></div>'
            + '<div data-separator="line-info"><span data-unmodified-lines>1 unmodified line</span></div>'
            + '<div data-separator="line-info"><span data-unmodified-lines>More unchanged context may be available</span></div>';
        localizePierreSeparatorText(root);
        localizePierreSeparatorText(root);
        expect([...root.querySelectorAll('[data-unmodified-lines]')].map((node) => node.textContent)).toEqual([
            t('hunkReview.unchangedLines', { count: 18 }),
            t('hunkReview.unchangedLines', { count: 1 }),
            'More unchanged context may be available',
        ]);
    });
});
