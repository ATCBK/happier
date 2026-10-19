import * as React from 'react';

type Listed = ReadonlyMap<string, readonly string[]>;
type Report = (automationId: string, runIds: readonly string[] | null) => void;

const NO_RUNS: ReadonlySet<string> = new Set();
const ListedContext = React.createContext<ReadonlySet<string>>(NO_RUNS);
const ReportContext = React.createContext<Report | null>(null);

/**
 * The Runs an open trigger History lists, for the Work pane's other Run list: a Run already shown
 * under its trigger is not shown a second time under "Writes here". It only carries what History
 * renders; both lists keep reading their own windows.
 */
export function SessionTriggerHistoryScope(props: Readonly<{ children: React.ReactNode }>) {
    const [byAutomation, setByAutomation] = React.useState<Listed>(() => new Map());
    const report = React.useCallback<Report>((automationId, runIds) => {
        setByAutomation((current) => {
            const known = current.get(automationId);
            if (runIds === null ? known === undefined : known?.join('\u0000') === runIds.join('\u0000')) return current;
            const next = new Map(current);
            if (runIds === null) next.delete(automationId);
            else next.set(automationId, runIds);
            return next;
        });
    }, []);
    const listed = React.useMemo(() => new Set([...byAutomation.values()].flat()), [byAutomation]);
    return (
        <ReportContext.Provider value={report}>
            <ListedContext.Provider value={listed}>{props.children}</ListedContext.Provider>
        </ReportContext.Provider>
    );
}

/** History mounts this for the Runs it lists; unmounting (the History closing) releases them. */
export function useReportTriggerHistoryRuns(automationId: string, runIds: readonly string[]): void {
    const report = React.useContext(ReportContext);
    const signature = runIds.join('\u0000');
    React.useEffect(() => {
        report?.(automationId, signature === '' ? [] : signature.split('\u0000'));
        return () => report?.(automationId, null);
    }, [automationId, report, signature]);
}

export function useRunsListedInTriggerHistory(): ReadonlySet<string> {
    return React.useContext(ListedContext);
}
