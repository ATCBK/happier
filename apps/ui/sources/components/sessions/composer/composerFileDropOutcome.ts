import { t } from '@/text';
import type { ExternalFileDragItems } from '@/components/ui/treeDragDrop/externalFileDropAdapter';

/**
 * What releasing files from the computer onto the composer text will do (lab D3): one picture says
 * the number it takes in the tray, several files say how many, anything else keeps the plain verb.
 * Folders cannot be told apart from files before release, so they read as files until they land.
 */
export function describeComposerFileDropOutcome(
  input: Readonly<{
    carried: ExternalFileDragItems;
    /** The number the next tray picture takes ("Image #N" is derived from tray order, never stored). */
    nextImageNumber: number;
    /** The host's own consequence line when its destination restricts what may be attached. */
    hint?: string;
  }>,
): Readonly<{ title: string; detail: string }> {
  const { carried } = input;
  const title =
    carried && carried.files > 1
      ? t('entityDragDrop.composer.mentionFiles', { count: carried.files })
      : carried?.files === 1 && carried.images === 1
        ? t('entityDragDrop.composer.attachAsImage', {
            number: input.nextImageNumber,
          })
        : t('entityDragDrop.composer.mentionHere');
  return {
    title,
    detail: input.hint ?? t('entityDragDrop.composer.attachAndMention'),
  };
}
