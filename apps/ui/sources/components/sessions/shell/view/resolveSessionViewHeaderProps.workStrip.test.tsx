import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { SessionHeaderSubagentsButton } from '@/components/sessions/actions/SessionHeaderSubagentsButton';
import { SessionHeaderWorkStrip } from '@/components/sessions/work/SessionHeaderWorkStrip';
import type { WorkSummary } from '@/components/sessions/work/workProjection';

import { resolveSessionViewHeaderProps } from './resolveSessionViewHeaderProps';

function rightElementChildren(props: ReturnType<typeof resolveSessionViewHeaderProps>): React.ReactNode[] {
    return React.Children.toArray(
        (props.rightElement as React.ReactElement<{ children?: React.ReactNode }>).props.children,
    );
}

function findByType(props: ReturnType<typeof resolveSessionViewHeaderProps>, type: unknown): React.ReactElement<any> | undefined {
    return rightElementChildren(props).find((child) => React.isValidElement(child) && child.type === type) as
        React.ReactElement<any> | undefined;
}

function summary(overrides: Partial<WorkSummary> = {}): WorkSummary {
    return { outstanding: 0, needsYou: 0, stalled: 0, sessions: 0, runs: 0, ...overrides };
}

function input(sessionId: string, workSummary: WorkSummary, subagentActiveCount = 0) {
    const session = createSessionFixture({
        id: sessionId,
        metadata: { path: '/tmp/project', host: 'test-host' },
    });
    return {
        isDataReady: true,
        session,
        sessionId: session.id,
        sessionInfoHref: `/session/${sessionId}/info`,
        sessionRunsHref: `/session/${sessionId}/runs`,
        sessionAutomationsHref: `/session/${sessionId}/automations`,
        paneScopeId: 'pane-1',
        windowWidth: 1200,
        sessionAutomationsEnabledCount: 0,
        sessionExecutionRunsSupported: false,
        showAutomations: false,
        shouldShowSubagentsButton: false,
        subagentActiveCount,
        workSummary,
        navigateWithBlurOnWeb: (action: () => void) => action(),
        handleHeaderExtraItemSelect: () => false,
        router: { push: () => {}, navigate: () => {} },
        actionIconColor: '#000',
        headerTintColor: '#000',
        statusErrorColor: '#f00',
        externalSessionRuntime: null,
    } as const;
}

describe('resolveSessionViewHeaderProps work strip', () => {
    it('shows the work strip while the lead has outstanding work, in place of the subagents button', () => {
        const props = resolveSessionViewHeaderProps(input('strip-lead', summary({ outstanding: 3, needsYou: 1, sessions: 2, runs: 2 }), 2));

        const strip = findByType(props, SessionHeaderWorkStrip);
        expect(strip?.props.summary).toMatchObject({ outstanding: 3, needsYou: 1 });
        expect(findByType(props, SessionHeaderSubagentsButton)).toBeUndefined();
    });

    it('keeps the closed header identity across updates that do not change the counts it shows', () => {
        const first = resolveSessionViewHeaderProps(input('strip-stable', summary({ outstanding: 3, needsYou: 1, sessions: 2, runs: 2 })));
        // A new projection object with the same outstanding and needs-you counts (a settled run moved
        // from "runs" bookkeeping, a row's title changed) is an unrelated update for the header.
        const second = resolveSessionViewHeaderProps(input('strip-stable', summary({ outstanding: 3, needsYou: 1, sessions: 2, runs: 3 })));

        expect(second).toBe(first);
    });

    it('re-resolves when the counts the strip shows change', () => {
        const first = resolveSessionViewHeaderProps(input('strip-change', summary({ outstanding: 3, needsYou: 1 })));
        const second = resolveSessionViewHeaderProps(input('strip-change', summary({ outstanding: 3, needsYou: 2 })));
        const settled = resolveSessionViewHeaderProps(input('strip-change', summary({ outstanding: 0, needsYou: 0 })));

        expect(second).not.toBe(first);
        expect(findByType(second, SessionHeaderWorkStrip)?.props.summary.needsYou).toBe(2);
        expect(findByType(settled, SessionHeaderWorkStrip)).toBeUndefined();
    });

    it('refreshes the cached strip when working work stalls and recovers without changing outstanding totals', () => {
        const working = resolveSessionViewHeaderProps(input('strip-stalled', summary({ outstanding: 1 })));
        const stalled = resolveSessionViewHeaderProps(input('strip-stalled', summary({ outstanding: 1, stalled: 1 })));
        const recovered = resolveSessionViewHeaderProps(input('strip-stalled', summary({ outstanding: 1 })));

        expect(stalled).not.toBe(working);
        expect(findByType(stalled, SessionHeaderWorkStrip)?.props.summary.stalled).toBe(1);
        expect(findByType(recovered, SessionHeaderWorkStrip)?.props.summary.stalled).toBe(0);
        expect(recovered).toBe(working);
    });
});
