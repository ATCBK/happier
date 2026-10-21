import { describe, expect, it, vi } from 'vitest';

import { act } from '@/dev/testkit/hooks/renderHook';
import {
  createTestSessionTranscriptSource,
  renderHookWithSessionTranscriptSource,
} from '@/dev/testkit/sessionTranscriptSource';
import type { MessageStructuredReferences } from './messageStructuredReferences';
import { useMessageInlineReferences } from './useMessageInlineReferences';

const sessionRef = 'session:relay-retry';
const imageRef = 'attachment:draft-b';

/** A sent message: a Session chip and the second of two numbered pictures. */
const projection: MessageStructuredReferences = {
  inline: new Map([
    [
      sessionRef,
      {
        ref: sessionRef,
        kind: 'happier.session',
        label: 'Relay retry with backoff',
        marker: '@Session "Relay retry with backoff"',
        glyph: 'conversations',
        sessionId: 'relay-retry',
      },
    ],
    [
      imageRef,
      {
        ref: imageRef,
        kind: 'attachment',
        label: 'Image #2',
        marker: '[Image #2]',
        glyph: 'preview',
        attachmentId: 'draft-b',
        path: '.happier/uploads/after.png',
        imageNumber: 2,
      },
    ],
  ]),
  row: [],
  imageNumbers: new Map([
    ['draft-a', 1],
    ['draft-b', 2],
  ]),
};
const pictures = [
  { path: '.happier/uploads/before.png', numberKey: 'draft-a' },
  { path: '.happier/uploads/after.png', numberKey: 'draft-b' },
];

async function renderInlineReferences() {
  const navigate = vi.fn();
  const openPath = vi.fn(() => true);
  const hook = await renderHookWithSessionTranscriptSource(
    () =>
      useMessageInlineReferences({
        projection,
        pictures,
        serverId: 'srv',
        openPath,
      }),
    { source: createTestSessionTranscriptSource({ navigate }) },
  );
  return { hook, navigate, openPath };
}

describe('useMessageInlineReferences', () => {
  it('resolves a bound token to the shared chip in the bubble ink and leaves unbound refs as text', async () => {
    const { hook } = await renderInlineReferences();
    const references = hook.getCurrent().inlineReferences!;
    expect(references.resolve(sessionRef)).toMatchObject({
      label: 'Relay retry with backoff',
      glyph: 'conversations',
    });
    expect(references.resolve('session:not-in-this-message')).toBeNull();
    expect(hook.getCurrent().pictures.numbers).toEqual(
      new Map([
        ['.happier/uploads/before.png', 1],
        ['.happier/uploads/after.png', 2],
      ]),
    );
  });

  it('opens a Session chip and rings the picture an "Image #N" chip names, without opening a file', async () => {
    const { hook, navigate, openPath } = await renderInlineReferences();
    await act(async () => {
      hook.getCurrent().inlineReferences!.onPress?.(sessionRef);
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(String(navigate.mock.calls[0]?.[0])).toContain('relay-retry');

    await act(async () => {
      hook.getCurrent().inlineReferences!.onPress?.(imageRef);
    });
    expect(hook.getCurrent().pictures.ringedPath).toBe(
      '.happier/uploads/after.png',
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it('shows a loaded picture inside its own chip', async () => {
    const { hook } = await renderInlineReferences();
    expect(
      hook.getCurrent().inlineReferences!.resolve(imageRef)?.thumbnail,
    ).toBeUndefined();
    await act(async () => {
      hook
        .getCurrent()
        .pictures.onPreviewLoaded('.happier/uploads/after.png', 'blob:after');
    });
    expect(
      hook.getCurrent().inlineReferences!.resolve(imageRef)?.thumbnail,
    ).toEqual({ uri: 'blob:after' });
  });
});
