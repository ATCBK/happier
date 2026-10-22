import { describe, expect, it } from 'vitest';
import { formatAttachmentSelectionSummary } from './sessionAttachmentsInputV1.js';
import { buildUploadedAttachment, buildAttachmentMessageMeta, SessionAttachmentsMessageMetaV1Schema } from './sessionAttachmentsInputV1.js';
import { RawIngressStructuredInputV1Schema } from '../../runtime/input/structuredInputV1.js';

it('carries the tray id unchanged through image dispatch and attachment metadata', () => {
  const uploaded = buildUploadedAttachment({ id: 'tray-1', name: 'photo.png', path: '/uploads/photo.png', mimeType: 'image/png', sizeBytes: 12 });
  const meta = buildAttachmentMessageMeta([uploaded]);
  expect(uploaded.structuredInput).toMatchObject({ id: 'tray-1' });
  expect(RawIngressStructuredInputV1Schema.parse(meta.happierStructuredInputV1)).toMatchObject({
    imageInputs: [{ id: 'tray-1', kind: 'localImage', path: '/uploads/photo.png' }],
  });
  expect(SessionAttachmentsMessageMetaV1Schema.parse(meta.happier).payload.attachments[0]).toMatchObject({ id: 'tray-1' });
  const recovered = buildAttachmentMessageMeta([{ ...uploaded, structuredInput: { ...uploaded.structuredInput!, id: 'old-image-id' } }]);
  expect(recovered.happierStructuredInputV1).toMatchObject({ imageInputs: [{ id: 'tray-1' }] });
});

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
