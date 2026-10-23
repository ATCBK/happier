import * as React from 'react';

/**
 * Where the phone Ask flow stands (P5 §3.9, D-4): `open` seats the one Session composer in a sheet over the
 * File page; `working` is the capsule left after Send until the turn settles. The phone Session cockpit owns
 * it, because it is the common parent of the File page and of the Session screen that mounts the composer.
 */
export type PhoneAskSheetPhase = 'closed' | 'open' | 'working';

export type PhoneAskSheetController = Readonly<{
  phase: PhoneAskSheetPhase;
  /** Ask from a selection: the composer (already holding its quote chip) rises over the page. */
  open: () => void;
  /** Dismissed without sending: the composer returns to the Session screen with its draft. */
  close: () => void;
  /** Sent: the sheet collapses to the working capsule. */
  sent: () => void;
  /** The turn settled, or the person went to the Session: the capsule leaves. */
  finish: () => void;
}>;

const PhoneAskSheetContext =
  React.createContext<PhoneAskSheetController | null>(null);

/** The cockpit's state; `null` where no phone cockpit seats the composer (desktop, tablet, classic). */
export function usePhoneAskSheetState(
  enabled: boolean,
): PhoneAskSheetController | null {
  const [phase, setPhase] = React.useState<PhoneAskSheetPhase>('closed');
  React.useEffect(() => {
    if (!enabled) setPhase('closed');
  }, [enabled]);
  const open = React.useCallback(() => setPhase('open'), []);
  const close = React.useCallback(
    () => setPhase((current) => (current === 'open' ? 'closed' : current)),
    [],
  );
  const sent = React.useCallback(
    () => setPhase((current) => (current === 'open' ? 'working' : current)),
    [],
  );
  const finish = React.useCallback(
    () => setPhase((current) => (current === 'working' ? 'closed' : current)),
    [],
  );
  return React.useMemo(
    () => (enabled ? { phase, open, close, sent, finish } : null),
    [close, enabled, finish, open, phase, sent],
  );
}

export function PhoneAskSheetProvider(
  props: React.PropsWithChildren<
    Readonly<{ value: PhoneAskSheetController | null }>
  >,
) {
  return (
    <PhoneAskSheetContext.Provider value={props.value}>
      {props.children}
    </PhoneAskSheetContext.Provider>
  );
}

export function usePhoneAskSheet(): PhoneAskSheetController | null {
  return React.useContext(PhoneAskSheetContext);
}
