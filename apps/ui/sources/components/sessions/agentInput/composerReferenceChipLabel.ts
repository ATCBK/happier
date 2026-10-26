import { scanInlineReferenceTokensV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { parseMentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';

import { t } from '@/text';

/**
 * What an inline reference chip reads: the reference's own label, else the label its token
 * carries, else the reference's opaque identity. The live composer and its static picture both
 * name a chip through this one rule.
 */
export function resolveComposerReferenceChipLabel(
  reference: Readonly<{
    ref: string;
    token: string;
    label?: string;
  }>,
): string {
  const tokenLabel = scanInlineReferenceTokensV1(reference.token).find(
    (token) => token.start === 0 && token.end === reference.token.length,
  )?.label;
  return (
    reference.label ??
    tokenLabel ??
    parseMentionRefV1(reference.ref)?.opaque ??
    t('common.unavailable')
  );
}
