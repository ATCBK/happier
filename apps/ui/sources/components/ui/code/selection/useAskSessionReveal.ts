import * as React from 'react';

import { usePaneMainColumn } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import { usePhoneAskSheet } from '@/components/sessions/composer/phoneAsk/phoneAskSheetState';

/**
 * What an Ask does to show the Session composer once its draft is saved: on a phone Session cockpit the
 * composer rises in the Ask sheet over the page; elsewhere a hidden Session column comes back.
 * Every Ask entry (selection toolbars, change rows, Problems, walkthrough stops) reveals through this one owner.
 * A surface that otherwise hands off to the Session itself (a full-page reading) passes that handoff as
 * `otherwise`; the phone sheet still wins, so the page being asked about stays in view.
 */
export function useAskSessionReveal(otherwise?: () => void): () => void {
  const mainColumn = usePaneMainColumn();
  const phoneAsk = usePhoneAskSheet();
  return React.useCallback(() => {
    if (phoneAsk) {
      phoneAsk.open();
      return;
    }
    if (otherwise) {
      otherwise();
      return;
    }
    if (mainColumn?.hidden) mainColumn.setHidden(false);
  }, [mainColumn, otherwise, phoneAsk]);
}
