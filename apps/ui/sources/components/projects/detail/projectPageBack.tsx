import * as React from 'react';

/** Takes the way back out of an open page (a pushed detail), or null once the page has closed it. */
type RegisterProjectPageBack = (back: (() => void) | null) => void;

const ProjectPageBackContext = React.createContext<RegisterProjectPageBack | null>(null);

/**
 * The Project's phone bar owns Back. While a page inside the Project has pushed a detail of its own,
 * that Back must close the detail instead of leaving the Project, so the page registers its way out here
 * rather than drawing a second arrow beside the bar's.
 */
export const ProjectPageBackProvider = ProjectPageBackContext.Provider;

/**
 * While `active`, hands `back` to the hosting Project bar. Returns whether a bar hosts the page: when it
 * does, the page draws no Back of its own; elsewhere (a Session's panel) it keeps its own.
 */
export function useProjectPageBack(active: boolean, back: () => void): boolean {
    const register = React.useContext(ProjectPageBackContext);
    const backRef = React.useRef(back);
    backRef.current = back;
    React.useEffect(() => {
        if (!active || !register) return;
        register(() => backRef.current());
        return () => register(null);
    }, [active, register]);
    return register !== null;
}
