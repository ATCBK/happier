import { describe, expect, it } from 'vitest';
import { SessionRunnerRuntimeStateV1Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV1';

import { buildMcpSelectionRestartNoticePresentation } from './mcpSelectionRestartNoticePresentation';

const metadata = {
    mcpSelectionV1: {
        v: 1,
        managedServersEnabled: true,
        forceIncludeServerIds: ['server-new'],
        forceExcludeServerIds: [],
    },
    mcpSelectionRestartRequiredV1: {
        v: 1,
        appliedSelection: {
            v: 1,
            managedServersEnabled: true,
            forceIncludeServerIds: [],
            forceExcludeServerIds: [],
        },
    },
};

describe('buildMcpSelectionRestartNoticePresentation', () => {
    it('leaves automatic application to the host timing owner rather than showing a manual restart', () => {
        expect(buildMcpSelectionRestartNoticePresentation({ sessionActive: true, metadata: { ...metadata,
            agentRuntimeCapabilitiesV1: { capabilitySelection: { vendorResume: 'supported', skillsLiveReload: 'unsupported' } } },
            operationStatus: null, translate: key => key })).toBeNull();
    });
    it.each(['windows_hosted_runner', 'not_daemon_started', 'not_remote_started'] as const)('keeps the D34 manual restart notice for %s', disabledReason => {
        const runtime = SessionRunnerRuntimeStateV1Schema.parse({ v: 1, sessionId: 'session-1', observedAtMs: 1,
            runner: { entrypointSource: 'structured_state', startedBy: 'daemon', startingMode: 'remote' },
            daemon: { currentEntrypointSource: 'packaged_runtime' }, versionState: 'current', statusSource: 'runner_report',
            plannedRestart: { supported: true, eligible: false, disabledReason } });
        expect(buildMcpSelectionRestartNoticePresentation({ sessionActive: true, metadata: { ...metadata, sessionRunnerRuntimeV1: runtime,
            agentRuntimeCapabilitiesV1: { capabilitySelection: { vendorResume: 'supported', skillsLiveReload: 'unsupported' } } },
            operationStatus: null, translate: key => key })).toMatchObject({ banner: { disabled: false } });
    });
    it('shows only a real active-session divergence', () => {
        expect(buildMcpSelectionRestartNoticePresentation({
            sessionActive: true,
            metadata,
            operationStatus: null,
            translate: (key) => key,
        })).toMatchObject({
            banner: { testID: 'session.mcpSelectionRestartRequired.banner', disabled: false },
            statusBadge: { key: 'session-mcp-selection-restart-required', tone: 'warning' },
        });
        expect(buildMcpSelectionRestartNoticePresentation({
            sessionActive: false,
            metadata,
            operationStatus: null,
            translate: (key) => key,
        })).toBeNull();
        expect(buildMcpSelectionRestartNoticePresentation({
            sessionActive: true,
            metadata: {
                ...metadata,
                mcpSelectionRestartRequiredV1: {
                    v: 1,
                    appliedSelection: metadata.mcpSelectionV1,
                },
            },
            operationStatus: null,
            translate: (key) => key,
        })).toBeNull();
    });
});
