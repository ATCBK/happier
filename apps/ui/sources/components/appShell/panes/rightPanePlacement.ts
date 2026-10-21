import * as React from 'react';

/**
 * Where the open right pane presents its tab: in the side column, or inside the session column over
 * the transcript, beside the composer (lab ade-shell AR1 EFv). The tab catalog decides it
 * (`resolveRightSidebarTabPlacement`); the scope host only lays its columns out from the answer.
 */
export type RightPanePlacement = 'side' | 'main';

export const RightPanePlacementReporterContext = React.createContext<
  ((placement: RightPanePlacement) => void) | null
>(null);

/** The right pane's catalog owner publishes its open tab's placement to the enclosing scope host. */
export function useReportRightPanePlacement(
  placement: RightPanePlacement,
): void {
  const report = React.useContext(RightPanePlacementReporterContext);
  React.useLayoutEffect(() => {
    report?.(placement);
  }, [placement, report]);
  React.useLayoutEffect(() => () => report?.('side'), [report]);
}
