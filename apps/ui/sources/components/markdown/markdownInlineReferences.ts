/**
 * Inline references: a Markdown link whose destination is `<scheme>:<target>` names something the
 * caller owns (a review finding cited in a walkthrough stop). The caller resolves the target to the
 * label, severity and colours drawn where the author placed it, and receives its press; an unresolved or
 * unowned reference renders as its plain text. A reference is never an openable URL.
 */
export type { MarkdownInlineReference, MarkdownInlineReferences } from '@happier-dev/plugin-ui/components';

import { INLINE_REFERENCE_HREF_PREFIX_V1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';

/** The owner's target of a rendered reference link, or null when the link is not this owner's reference. */
export function readMarkdownInlineReferenceTarget(href: string, scheme?: string): string | null {
    const prefix = `${INLINE_REFERENCE_HREF_PREFIX_V1}${scheme ? `${scheme}:` : ''}`;
    return href.startsWith(prefix) && href.length > prefix.length ? href.slice(prefix.length) : null;
}
