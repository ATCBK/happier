import { describe, expect, it } from 'vitest';

import { parseActivityInteraction } from './parseActivityInteraction';
import { resolveActivityInteractionCommand } from './resolveActivityInteractionCommand';

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';

function tap(data: unknown) {
    return resolveActivityInteractionCommand({
        actionIdentifier: DEFAULT_ACTION,
        defaultActionIdentifier: DEFAULT_ACTION,
        data,
        // A fresh client that has loaded no Sessions at all: a workflow Run must
        // still open, because a Run is Account-scoped and outlives its origin.
        knownIdentities: [],
    });
}

describe('workflow_run_update notification interaction', () => {
    it('parses a validated runId into a typed workflow target and exact route', () => {
        const parsed = parseActivityInteraction({
            actionIdentifier: DEFAULT_ACTION,
            defaultActionIdentifier: DEFAULT_ACTION,
            data: { topic: 'workflow_run_update', runId: 'run-42', updateKind: 'interrupted' },
        });

        expect(parsed?.workflowRun).toEqual({ runId: 'run-42' });
        expect(parsed?.route).toBe('/workflows/runs/run-42');
        expect(parsed?.isOpenAction).toBe(true);
    });

    it('opens the exact Run with no known Session identity', () => {
        const command = tap({ topic: 'workflow_run_update', runId: 'run-42', updateKind: 'paused' });

        expect(command).toEqual({
            kind: 'openWorkflowRun',
            runId: 'run-42',
            serverId: null,
            serverUrl: null,
            route: '/workflows/runs/run-42',
        });
    });

    it('carries the server selection the payload named so the tap switches first', () => {
        const command = tap({
            topic: 'workflow_run_update',
            runId: 'run-42',
            updateKind: 'completed',
            serverId: 'server-1',
            serverUrl: 'https://api.example.test',
        });

        expect(command).toMatchObject({
            kind: 'openWorkflowRun',
            serverId: 'server-1',
            serverUrl: 'https://api.example.test',
            route: '/workflows/runs/run-42?serverId=server-1',
        });
        expect(parseActivityInteraction({ actionIdentifier: DEFAULT_ACTION, defaultActionIdentifier: DEFAULT_ACTION,
            data: { topic: 'workflow_run_update', runId: 'run-42', updateKind: 'completed', serverId: 'server-1' } })?.route)
            .toBe('/workflows/runs/run-42?serverId=server-1');
    });

    it('never routes to a caller-supplied url for a workflow update', () => {
        const command = tap({
            topic: 'workflow_run_update',
            runId: 'run-42',
            updateKind: 'failed',
            url: '/settings/account',
        });

        expect(command).toMatchObject({ kind: 'openWorkflowRun', route: '/workflows/runs/run-42' });
    });

    it('encodes a runId that is not URL safe', () => {
        const command = tap({ topic: 'workflow_run_update', runId: 'run/42 a', updateKind: 'completed' });

        expect(command).toMatchObject({ route: '/workflows/runs/run%2F42%20a' });
    });

    it('fails closed on a missing or malformed runId', () => {
        expect(tap({ topic: 'workflow_run_update', updateKind: 'completed' })).toMatchObject({ kind: 'ignore' });
        expect(tap({ topic: 'workflow_run_update', runId: '', updateKind: 'completed' })).toMatchObject({ kind: 'ignore' });
        expect(tap({ topic: 'workflow_run_update', runId: 42, updateKind: 'completed' })).toMatchObject({ kind: 'ignore' });
        expect(tap({ topic: 'workflow_run_update', runId: 'run-42', updateKind: 'invented' })).toMatchObject({ kind: 'ignore' });
    });

    it('does not route a non-workflow payload that merely carries a runId', () => {
        const command = tap({ topic: 'ready', runId: 'run-42' });

        expect(command).not.toMatchObject({ kind: 'openWorkflowRun' });
    });
});
