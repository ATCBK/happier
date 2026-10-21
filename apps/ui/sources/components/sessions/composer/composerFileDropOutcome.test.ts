import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import {
  createExternalFileDropBinding,
  readExternalFileDragItems,
} from '@/components/ui/treeDragDrop/externalFileDropAdapter';
import { describeComposerFileDropOutcome } from './composerFileDropOutcome';

describe('describeComposerFileDropOutcome', () => {
  it('names the picture number a single carried image will take in the tray', () => {
    expect(
      describeComposerFileDropOutcome({
        carried: { files: 1, images: 1 },
        nextImageNumber: 3,
      }),
    ).toEqual({
      title: t('entityDragDrop.composer.attachAsImage', { number: 3 }),
      detail: t('entityDragDrop.composer.attachAndMention'),
    });
  });

  it('counts several carried files', () => {
    expect(
      describeComposerFileDropOutcome({
        carried: { files: 2, images: 1 },
        nextImageNumber: 1,
      }).title,
    ).toBe(t('entityDragDrop.composer.mentionFiles', { count: 2 }));
  });

  it('keeps the plain verb for one file that is not a picture, or when the browser hides the items', () => {
    expect(
      describeComposerFileDropOutcome({
        carried: { files: 1, images: 0 },
        nextImageNumber: 1,
      }).title,
    ).toBe(t('entityDragDrop.composer.mentionHere'));
    expect(
      describeComposerFileDropOutcome({ carried: null, nextImageNumber: 1 })
        .title,
    ).toBe(t('entityDragDrop.composer.mentionHere'));
  });

  it('lets the host explain a restricted destination in place of the default consequence', () => {
    expect(
      describeComposerFileDropOutcome({
        carried: { files: 1, images: 1 },
        nextImageNumber: 1,
        hint: 'Files only',
      }).detail,
    ).toBe('Files only');
  });
});

describe('external file drag carried items', () => {
  const fileDrag = (items: readonly { kind: string; type: string }[]) => ({
    dataTransfer: { types: ['Files'], items, files: [] as unknown as FileList },
    clientX: 10,
    clientY: 10,
    preventDefault: () => {},
    stopPropagation: () => {},
  });

  it('summarises what the active drag carries before the target reports it active, and forgets it on retire', () => {
    let seenWhenActive:
      | ReturnType<typeof readExternalFileDragItems>
      | undefined;
    const binding = createExternalFileDropBinding(() => ({
      enabled: true,
      onFilesDropped: () => {},
      onFileDragActiveChange: (active) => {
        if (active) seenWhenActive = readExternalFileDragItems();
      },
    }));
    const unmount = binding.mount();
    binding.handlers.onDragEnter(
      fileDrag([
        { kind: 'file', type: 'image/png' },
        { kind: 'file', type: 'text/plain' },
        { kind: 'string', type: 'text/uri-list' },
      ]),
    );
    expect(seenWhenActive).toEqual({ files: 2, images: 1 });
    binding.handlers.onDrop(fileDrag([{ kind: 'file', type: 'image/png' }]));
    expect(readExternalFileDragItems()).toBeNull();
    unmount();
  });
});
