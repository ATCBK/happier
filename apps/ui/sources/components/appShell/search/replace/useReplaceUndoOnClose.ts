import * as React from 'react';

import {
  publishPresentationNotice,
  retirePresentationNotice,
} from '@/components/sessions/presentation/presentationNotices';
import type { WorkspaceReplaceModel } from '@/sync/domains/workspaces/files/workspaceFileReplace';
import { t } from '@/text';

const NOTICE_KEY = 'universal-search:replace-undo';

/**
 * One Undo per state: while the surface is open its result row owns Undo; when the surface closes with
 * Undo still possible, the app's sticky presentation notice carries it. The recorded edits stay in this
 * closure only (no store); a newer notice replacing this one ends the offer, as for every notice.
 */
export function useReplaceUndoOnClose(
  model: WorkspaceReplaceModel,
  machineLabel: string,
): void {
  const latest = React.useRef({ model, machineLabel });
  latest.current = { model, machineLabel };
  React.useEffect(
    () => () => {
      const { model: closing, machineLabel: machine } = latest.current;
      const offer = closing.undoOnClose;
      if (!offer) return;
      const undoable = offer.results;
      if (!undoable.length) return;
      const matches = undoable.reduce(
        (sum, result) => sum + (result.matchCount ?? 0),
        0,
      );
      const undo = offer.run;
      publishPresentationNotice({
        key: NOTICE_KEY,
        severity: 'info',
        sticky: true,
        message: t('universalSearch.replace.replacedTitle', {
          matches,
          files: undoable.length,
        }),
        undo: {
          label: t('universalSearch.replace.undo'),
          run: () => {
            void undo().then((outcome) => {
              if (!outcome) {
                retirePresentationNotice(NOTICE_KEY);
                return;
              }
              publishPresentationNotice({
                key: NOTICE_KEY,
                severity: outcome.error ? 'error' : 'info',
                message:
                  outcome.error === 'outcome_unknown'
                    ? t('universalSearch.replace.outcomeUnknown', { machine })
                    : outcome.error
                      ? t('universalSearch.replace.undoFailed', { machine })
                      : outcome.changed > 0
                        ? t('universalSearch.replace.undoneExceptChanged', {
                            count: outcome.changed,
                          })
                        : t('universalSearch.replace.undoneTitle'),
              });
            });
          },
        },
      });
    },
    [],
  );
}
