import { describe, expect, it } from 'vitest';
import { writeSessionStateFieldToMetadata } from '@happier-dev/agents/session/state/metadataWriters';

import { tryReadApiSessionMetadataForLayout } from './sessionMetadataLayout';

describe('layout-0 title arbitration', () => {
  it('preserves real retained title text without a timestamp against a zero-time drop write', () => {
    const metadata = tryReadApiSessionMetadataForLayout({ summary: { text: 'Retained title' } }, 0);
    expect(metadata).not.toBeNull();
    if (!metadata) throw new Error('Layout-0 metadata was not accepted');

    const next = writeSessionStateFieldToMetadata(metadata, 'display.title', {
      title: 'Older zero-time title',
      updatedAt: 0,
      staleBehavior: 'drop',
    });

    expect(next.summary).toMatchObject({ text: 'Retained title' });
    expect(next).toBe(metadata);
  });
});
