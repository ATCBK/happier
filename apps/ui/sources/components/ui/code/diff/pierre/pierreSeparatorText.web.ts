import { t } from '@/text';

// The library writes its separator count in fixed English ("18 unmodified lines"). Both renderers say the
// app's own string instead, so the Happier placeholder's band and Pierre's read the same in every language.
const PIERRE_SEPARATOR_COUNT = /^(\d+) unmodified lines?$/;

export function localizePierreSeparatorText(root: ParentNode): void {
    for (const node of root.querySelectorAll<HTMLElement>('[data-unmodified-lines]')) {
        const match = PIERRE_SEPARATOR_COUNT.exec(node.textContent ?? '');
        if (match) node.textContent = t('hunkReview.unchangedLines', { count: Number(match[1]) });
    }
}
