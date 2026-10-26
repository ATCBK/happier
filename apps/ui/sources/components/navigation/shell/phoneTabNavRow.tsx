import * as React from 'react';

/**
 * The phone tab shell's line for a column that is the whole page (calm-shell `clviews:recentP`): instead of
 * a separate bar above it, the shell hands the column its Home line (`leading`) and its glyphs (`trailing`),
 * and the column draws one nav row — the Home line, its own controls, the shell glyphs — above its large title.
 * Only the phone tab shell provides it; every other host keeps the column's own title row.
 */
export type PhoneTabNavRow = Readonly<{
  leading: React.ReactNode;
  trailing: React.ReactNode;
}>;

const PhoneTabNavRowContext = React.createContext<PhoneTabNavRow | null>(null);

export function PhoneTabNavRowProvider(
  props: Readonly<PhoneTabNavRow & { children: React.ReactNode }>,
) {
  const { leading, trailing, children } = props;
  const value = React.useMemo(
    (): PhoneTabNavRow => ({ leading, trailing }),
    [leading, trailing],
  );
  return (
    <PhoneTabNavRowContext.Provider value={value}>
      {children}
    </PhoneTabNavRowContext.Provider>
  );
}

export function usePhoneTabNavRow(): PhoneTabNavRow | null {
  return React.useContext(PhoneTabNavRowContext);
}
