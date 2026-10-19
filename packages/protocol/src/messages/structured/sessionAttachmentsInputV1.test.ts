import { describe, expect, it } from 'vitest';
import { formatAttachmentSelectionSummary } from './sessionAttachmentsInputV1.js';

describe('formatAttachmentSelectionSummary', () => {
  it('describes actual selected names and known metadata without implying an uploaded path', () => {
    expect(formatAttachmentSelectionSummary([
      { name: 'note.txt', mimeType: 'text/plain', sizeBytes: 5 },
      { name: 'native-photo.png', mimeType: 'image/png' },
      { name: 'empty.txt', sizeBytes: 0 },
      { name: 'unknown-size.bin' },
    ])).toBe('Attachments:\n- note.txt (text/plain, 5 bytes)\n- native-photo.png (image/png)\n- empty.txt (0 bytes)\n- unknown-size.bin');
  });

  it('does not invent an attachment selection for an empty list', () => {
    expect(formatAttachmentSelectionSummary([])).toBe('');
  });
});
