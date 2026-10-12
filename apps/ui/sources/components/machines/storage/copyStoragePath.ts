import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

/**
 * Copy a storage item's path on its machine (the daemon's exact path, for pasting into a prompt or a terminal there).
 * Clipboard only: it never opens or touches the item. Agents reach the same text through `clipboard.write` with a
 * path read from the storage Actions.
 */
export function copyStoragePath(path: string): void {
  fireAndForget(
    setClipboardStringSafe(path).then((copied) => {
      if (copied) publishPresentationNotice({ key: 'machine-storage:path-copied', severity: 'info', message: t('common.copied') });
    }),
    { tag: 'MachineStorage.copyPath' },
  );
}
