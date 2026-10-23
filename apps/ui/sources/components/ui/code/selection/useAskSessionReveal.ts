import * as React from 'react';

import { usePaneMainColumn } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import { usePhoneAskSheet } from '@/components/sessions/composer/phoneAsk/phoneAskSheetState';

/**
 * What an Ask does to show the Session composer once its draft is saved: on a phone Session cockpit the
 * composer rises in the Ask sheet over the page; elsewhere a hidden Session column comes back.
 * Every Ask entry (selection toolbars, change rows, Problems) reveals through this one owner.
 */
export function useAskSessionReveal(): () => void {
  const mainColumn = usePaneMainColumn();
  const phoneAsk = usePhoneAskSheet();
  return React.useCallback(() => {
    if (phoneAsk) {
      phoneAsk.open();
      return;
    }
    if (mainColumn?.hidden) mainColumn.setHidden(false);
  }, [mainColumn, phoneAsk]);
}
