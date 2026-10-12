import * as React from 'react';

/**
 * The leading column of a page section, decided once per section.
 *
 * A page section's rows share one leading column: when any row carries a leading icon or mark, every
 * row in that section reserves the column, so all titles in the section start on one line. A section
 * with no icon rows reserves nothing. Rows report whether they have a leading element; the section
 * (`ItemGroup` under page presentation) owns the answer. Outside a page section there is no provider
 * and each row keeps only its own leading element.
 */
type SectionLeadingColumn = Readonly<{
    reserve: boolean;
    register: () => () => void;
}>;

const SectionLeadingColumnContext = React.createContext<SectionLeadingColumn | null>(null);

export function SectionLeadingColumnProvider(props: Readonly<{ children: React.ReactNode }>) {
    const [leadingRows, setLeadingRows] = React.useState(0);
    const register = React.useCallback(() => {
        setLeadingRows((count) => count + 1);
        return () => setLeadingRows((count) => count - 1);
    }, []);
    const reserve = leadingRows > 0;
    const value = React.useMemo(() => ({ reserve, register }), [register, reserve]);
    return <SectionLeadingColumnContext.Provider value={value}>{props.children}</SectionLeadingColumnContext.Provider>;
}

// The count settles before paint, so a section never draws its titles in one place and then moves them.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

/**
 * Registers this row's leading element with its section and returns whether the section reserves the
 * leading column (true for every row of a section in which any row has one).
 */
export function useSectionLeadingColumn(hasLeading: boolean): boolean {
    const section = React.useContext(SectionLeadingColumnContext);
    const register = section?.register;
    useIsomorphicLayoutEffect(() => {
        if (!hasLeading || !register) return undefined;
        return register();
    }, [hasLeading, register]);
    return section?.reserve ?? false;
}

/** Whether this row sits inside a section (`ItemGroup`), so a row-shaped notice knows it already has its sheet. */
export function useIsInsideItemSection(): boolean {
    return React.useContext(SectionLeadingColumnContext) !== null;
}
