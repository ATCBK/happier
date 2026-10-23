import { describe, expect, it } from 'vitest';

import type { DesktopActivityOverlaySnapshot } from './buildDesktopActivityOverlaySnapshot';
import type { DesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';
import { activityInstanceKey, sessionAddressKey } from '@/sync/domains/session/sessionAddress';

import { buildDesktopActivityOverlayModel } from './buildDesktopActivityOverlayModel';

type RequestSnapshotFixture = Omit<DesktopActivityOverlaySnapshot['permissionRequests'][number], 'activityInstanceId'>
    & Partial<Pick<DesktopActivityOverlaySnapshot['permissionRequests'][number], 'activityInstanceId'>>;
type SnapshotOverrides = Omit<Partial<DesktopActivityOverlaySnapshot>, 'permissionRequests' | 'userQuestions'> & Readonly<{
    permissionRequests?: readonly RequestSnapshotFixture[];
    userQuestions?: readonly RequestSnapshotFixture[];
}>;

function requestActivityInstanceId(request: RequestSnapshotFixture): string {
    return request.activityInstanceId ?? activityInstanceKey(
        { serverId: request.serverId, sessionId: request.sessionId },
        JSON.stringify([request.kind, request.requestId]),
    );
}

function createSnapshot(overrides: SnapshotOverrides = {}): DesktopActivityOverlaySnapshot {
    const base: DesktopActivityOverlaySnapshot = {
        version: 1,
        generatedAt: 1_700_000_000_000,
        state: 'content',
        counts: {
            unread: 1,
            permissionRequired: 1,
            actionRequired: 0,
            thinking: 1,
            totalAttention: 2,
        },
        summaryCounts: {
            attentionCount: 2,
            runningCount: 1,
            permissionCount: 1,
        },
        permissionRequests: [],
        userQuestions: [],
        quotaSummaries: [],
        completionStates: [],
        primary: {
            serverId: 'server-1',
            sessionId: 'session-primary',
            title: 'Primary session',
            subtitle: 'agent on machine',
            statusText: 'Permission required',
            previewText: null,
            attentionState: 'permission_required',
            active: true,
            updatedAt: 10,
        },
        sessions: [
            {
                serverId: 'server-1',
                sessionId: 'session-primary',
                title: 'Primary session',
                subtitle: 'agent on machine',
                statusText: 'Permission required',
                previewText: null,
                attentionState: 'permission_required',
                active: true,
                updatedAt: 10,
            },
            {
                serverId: 'server-1',
                sessionId: 'session-secondary',
                title: 'Secondary session',
                subtitle: 'agent on machine',
                statusText: 'Running',
                previewText: null,
                attentionState: 'thinking',
                active: true,
                updatedAt: 9,
            },
        ],
        defaultTarget: 'open-primary-session',
        labels: {
            sessionsTitle: 'Sessions',
            emptyTitle: 'No active sessions',
        },
    };

    return {
        ...base,
        ...overrides,
        permissionRequests: (overrides.permissionRequests ?? base.permissionRequests).map((request) => ({
            ...request,
            activityInstanceId: requestActivityInstanceId(request),
        })),
        userQuestions: (overrides.userQuestions ?? base.userQuestions).map((request) => ({
            ...request,
            activityInstanceId: requestActivityInstanceId(request),
        })),
    };
}

function createPolicy(overrides: Partial<DesktopOverlayPolicy> = {}): DesktopOverlayPolicy {
    const base: DesktopOverlayPolicy = {
        enabled: true,
        visibilityMode: 'attention_only',
        showWhenRunning: true,
        showWhenAttentionRequired: true,
        showWhenReady: true,
        alwaysOnTop: true,
        autoHideEnabled: true,
        autoHideDelayMs: 6000,
        hoverExpandDelayMs: 500,
        expandedBehavior: 'click',
        interactiveCollapsed: true,
        presentationMode: 'automatic',
        clickAction: 'expand_overlay',
        density: 'compact',
        compactStyle: 'pill',
        showSessionCount: true,
        showPreviewText: false,
        collapsedCarouselEnabled: true,
        quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
        placementMode: 'anchored',
        anchor: 'top_center',
        offsetX: 0,
        offsetY: 0,
        enableDragReposition: false,
        lockPosition: true,
    };

    return {
        ...base,
        ...overrides,
    };
}

describe('buildDesktopActivityOverlayModel', () => {
    it('marks overlay visible when enabled and attention is present in attention mode', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy(),
            isExpanded: false,
        });

        expect(model.visible).toBe(true);
        expect(model.collapsed.title).toBe('Primary session');
        expect(model.collapsed.defaultTarget).toBe('open-primary-session');
        expect(model.collapsed.sessionCount).toBe(2);
        expect(model.expanded.rows).toHaveLength(2);
        expect(model.expanded.cards).toEqual([
            expect.objectContaining({
                kind: 'multi_session_list',
                rows: [
                    expect.objectContaining({ sessionId: 'session-primary' }),
                    expect.objectContaining({ sessionId: 'session-secondary' }),
                ],
            }),
        ]);
        expect(model.window.collapsed.width).toBeGreaterThan(200);
        expect(model.window.expanded.height).toBeGreaterThan(model.window.collapsed.height);
        expect(model.window.expanded.height).toBeLessThanOrEqual(176);
    });

    it('uses one passive expanded composition without duplicating the primary session', () => {
        const singleSessionModel = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                sessions: [
                    {
                        sessionId: 'session-primary',
                        serverId: 'server-1',
                        title: 'Primary session',
                        subtitle: 'agent on machine',
                        statusText: 'Ready',
                        previewText: null,
                        attentionState: 'pending_input',
                        active: true,
                        updatedAt: 10,
                    },
                ],
            }),
            policy: createPolicy(),
            isExpanded: true,
        });
        const multiSessionModel = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy(),
            isExpanded: true,
        });

        expect(singleSessionModel.expanded.cards).toEqual([
            expect.objectContaining({
                kind: 'session_overview',
                sessionId: 'session-primary',
            }),
        ]);
        expect(multiSessionModel.expanded.cards).toEqual([
            expect.objectContaining({
                kind: 'multi_session_list',
                rows: [
                    expect.objectContaining({ sessionId: 'session-primary' }),
                    expect.objectContaining({ sessionId: 'session-secondary' }),
                ],
            }),
        ]);
    });

    it('keeps pill collapsed windows tighter than panel collapsed windows for the same density', () => {
        const pillModel = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy({
                compactStyle: 'pill',
                density: 'compact',
            }),
            isExpanded: false,
        });
        const panelModel = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy({
                compactStyle: 'panel',
                density: 'compact',
            }),
            isExpanded: false,
        });

        expect(pillModel.window.collapsed.width).toBeLessThan(panelModel.window.collapsed.width);
        expect(pillModel.window.collapsed.height).toBeLessThan(panelModel.window.collapsed.height);
    });

    it('keeps compact collapsed pill windows in the dense notch-wing range', () => {
        const pillModel = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy({
                compactStyle: 'pill',
                density: 'compact',
            }),
            isExpanded: false,
        });
        const panelModel = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy({
                compactStyle: 'panel',
                density: 'compact',
            }),
            isExpanded: false,
        });

        expect(pillModel.window.collapsed).toEqual({ width: 254, height: 38 });
        expect(panelModel.window.collapsed.height).toBeLessThanOrEqual(68);
    });

    it('stays hidden when disabled regardless of counts', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy({
                enabled: false,
                visibilityMode: 'always_when_enabled',
            }),
            isExpanded: false,
        });

        expect(model.visible).toBe(false);
    });

    it('stays hidden in active-session mode when only inactive attention counts remain', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                state: 'idle',
                counts: {
                    unread: 1,
                    permissionRequired: 0,
                    actionRequired: 0,
                    thinking: 0,
                    totalAttention: 1,
                },
                summaryCounts: {
                    attentionCount: 1,
                    runningCount: 0,
                    permissionCount: 0,
                },
                primary: null,
                sessions: [],
                permissionRequests: [],
                userQuestions: [],
                completionStates: [],
            }),
            policy: createPolicy({
                visibilityMode: 'active_sessions',
                showWhenAttentionRequired: true,
            }),
            isExpanded: false,
        });

        expect(model.visible).toBe(false);
    });

    it('uses empty fallback copy when there is no primary session', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                state: 'idle',
                counts: {
                    unread: 0,
                    permissionRequired: 0,
                    actionRequired: 0,
                    thinking: 0,
                    totalAttention: 0,
                },
                permissionRequests: [],
                userQuestions: [],
                quotaSummaries: [],
                primary: null,
                sessions: [],
            }),
            policy: createPolicy({
                visibilityMode: 'always_when_enabled',
            }),
            isExpanded: false,
        });

        expect(model.visible).toBe(true);
        expect(model.collapsed.title).toBe('No active sessions');
        expect(model.expanded.cards).toEqual([
            expect.objectContaining({
                kind: 'idle_state',
            }),
        ]);
        expect(model.expanded.rows).toHaveLength(0);
    });

    it('omits widget-only fields from the desktop overlay presentation contract', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy({
                visibilityMode: 'always_when_enabled',
            }),
            isExpanded: true,
        });

        expect(model.collapsed).not.toHaveProperty('subtitle');
        expect(model.collapsed).not.toHaveProperty('previewText');
        expect(model.collapsed).not.toHaveProperty('attentionCount');
        expect(model.expanded.rows[0]).not.toHaveProperty('route');
        expect(model.expanded.rows[0]).not.toHaveProperty('target');
        expect(model.expanded.rows[0]).not.toHaveProperty('attentionState');
    });

    it('stays hidden in attention-only mode when sessions exist but every auto-show trigger is disabled', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                counts: {
                    unread: 0,
                    permissionRequired: 0,
                    actionRequired: 0,
                    thinking: 1,
                    totalAttention: 0,
                },
            }),
            policy: createPolicy({
                showWhenRunning: false,
                showWhenAttentionRequired: false,
                showWhenReady: false,
            }),
            isExpanded: false,
        });

        expect(model.visible).toBe(false);
    });

    it('does not auto-show for queued user input without real attention or completion state', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                counts: {
                    unread: 0,
                    permissionRequired: 0,
                    actionRequired: 0,
                    thinking: 0,
                    totalAttention: 0,
                },
                completionStates: [],
            }),
            policy: createPolicy({
                showWhenRunning: false,
                showWhenAttentionRequired: false,
                showWhenReady: true,
            }),
            isExpanded: false,
        });

        expect(model.visible).toBe(false);
        expect(model.collapsed.slides?.[0]?.priority).not.toBe('ready');
    });

    it('stays visible in active-sessions mode when sessions exist even if every auto-show trigger is disabled', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                counts: {
                    unread: 0,
                    permissionRequired: 0,
                    actionRequired: 0,
                    thinking: 0,
                    totalAttention: 0,
                },
            }),
            policy: createPolicy({
                visibilityMode: 'active_sessions',
                showWhenRunning: false,
                showWhenAttentionRequired: false,
                showWhenReady: false,
            }),
            isExpanded: false,
        });

        expect(model.visible).toBe(true);
    });

    it('prioritizes permission request cards ahead of passive session overview cards', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                permissionRequests: [
                    {
                        kind: 'permission_request',
                        requestId: 'perm-1',
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Approve command',
                        summary: 'npm test',
                        toolLabel: 'Bash',
                        questionText: null,
                        count: 1,
                        openActionIdentifier: 'open-session:session-primary',
                        allowActionIdentifier: 'session.permission.respond',
                        denyActionIdentifier: 'session.permission.respond',
                        directOptions: [],
                    },
                ],
            }),
            policy: createPolicy(),
            isExpanded: true,
        });

        expect(model.expanded.cards?.[0]).toEqual(expect.objectContaining({
            kind: 'permission_request',
            id: activityInstanceKey(
                { serverId: 'server-1', sessionId: 'session-primary' },
                JSON.stringify(['permission_request', 'perm-1']),
            ),
        }));
        expect(model.collapsed.title).toBe('Approve command');
        expect(model.collapsed.statusText).toBe('npm test');
        expect(model.collapsed.primaryCardKind).toBe('permission_request');
    });

    it('preserves exact request instance identity across Homes, sessions, reorder, and delimiter-bearing ids', () => {
        const requestInstanceId = (serverId: string, sessionId: string, kind: 'permission_request' | 'user_question', requestId: string) => (
            activityInstanceKey({ serverId, sessionId }, JSON.stringify([kind, requestId]))
        );
        const permissionRequest = (serverId: string, sessionId: string, requestId: string) => ({
            kind: 'permission_request' as const,
            activityInstanceId: requestInstanceId(serverId, sessionId, 'permission_request', requestId),
            requestId,
            serverId,
            sessionId,
            title: `Approve on ${serverId}/${sessionId}`,
            summary: null,
            toolLabel: 'Bash',
            questionText: null,
            count: 1,
            openActionIdentifier: `open-session:${sessionId}?serverId=${serverId}`,
            allowActionIdentifier: 'session.permission.respond',
            denyActionIdentifier: 'session.permission.respond',
            directOptions: [],
        });
        const requests = [
            permissionRequest('home-a', 'session-x', 'shared-request'),
            permissionRequest('home-b', 'session-x', 'shared-request'),
            permissionRequest('home-a', 'session-y', 'shared-request'),
            permissionRequest('https://home.example/a', 'b:c', 'request:with:delimiters'),
            permissionRequest('https://home.example/a:b', 'c', 'request:with:delimiters'),
        ];
        const buildCards = (permissionRequests: typeof requests) => buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({ permissionRequests }),
            policy: createPolicy(),
            isExpanded: true,
        }).expanded.cards?.filter((card) => card.kind === 'permission_request') ?? [];

        const original = buildCards(requests);
        const reorderedAfterResolve = buildCards([requests[4], requests[2], requests[1], requests[3]]);
        const originalIds = original.map((card) => card.id);

        expect(new Set(originalIds).size).toBe(requests.length);
        expect(originalIds).toEqual(requests.map((request) => request.activityInstanceId));
        expect(reorderedAfterResolve.map((card) => card.id)).toEqual([
            requests[4].activityInstanceId,
            requests[2].activityInstanceId,
            requests[1].activityInstanceId,
            requests[3].activityInstanceId,
        ]);
        expect(original[1]).toEqual(expect.objectContaining({
            requestId: 'shared-request',
            serverId: 'home-b',
            sessionId: 'session-x',
            actions: expect.arrayContaining([
                expect.objectContaining({
                    actionIdentifier: 'session.permission.respond',
                    data: expect.objectContaining({
                        requestId: 'shared-request',
                        serverId: 'home-b',
                        sessionId: 'session-x',
                    }),
                }),
            ]),
        }));
    });

    it('builds the four collapsed carousel slides from stable session transformations', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                generatedAt: 1_700_000_000_000,
                counts: {
                    unread: 0,
                    permissionRequired: 0,
                    actionRequired: 0,
                    thinking: 1,
                    totalAttention: 0,
                },
                summaryCounts: {
                    attentionCount: 0,
                    runningCount: 1,
                    permissionCount: 0,
                },
                primary: {
                    serverId: 'server-1',
                    sessionId: 'session-primary',
                    title: 'Improve checkout flow for authenticated users',
                    subtitle: 'happier/app',
                    statusText: 'Editing src/auth/very-long-middleware-filename.ts',
                    previewText: 'The assistant is updating the purchase surface.',
                    attentionState: 'thinking',
                    active: true,
                    updatedAt: 1_699_998_380_000,
                },
                sessions: [
                    {
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Improve checkout flow for authenticated users',
                        subtitle: 'happier/app',
                        statusText: 'Editing src/auth/very-long-middleware-filename.ts',
                        previewText: 'The assistant is updating the purchase surface.',
                        attentionState: 'thinking',
                        active: true,
                        updatedAt: 1_699_998_380_000,
                    },
                ],
            }),
            policy: createPolicy({
                showPreviewText: true,
            }),
            isExpanded: false,
        });

        expect(model.collapsed.carousel).toEqual({
            enabled: true,
            cadenceMs: 3000,
            freezeReason: null,
        });
        const slides = model.collapsed.slides ?? [];
        expect(slides.map((slide) => slide.id)).toEqual([
            'status',
            'task_title',
            'last_tool',
            'project_duration',
        ]);
        expect(slides[0]).toMatchObject({
            title: 'Editing src/auth/very-long-middleware-filename.ts',
            subtitle: 'Improve checkout flow for authenticated users',
            animatedEllipsis: true,
            priority: 'running',
        });
        expect(slides[1]).toMatchObject({
            title: 'Improve checkout flow...',
            subtitle: 'The assistant is updating the purchase surface.',
        });
        expect(slides[2]).toMatchObject({
            title: 'Edit: very-long...',
            subtitle: 'happier/app',
        });
        expect(slides[3]).toMatchObject({
            title: 'happier/app · 27m',
            subtitle: '1 session',
        });
    });

    it('redacts collapsed carousel preview subtitles when desktop preview text is disabled', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                primary: {
                    serverId: 'server-1',
                    sessionId: 'session-primary',
                    title: 'Improve checkout flow',
                    subtitle: 'happier/app',
                    statusText: 'Editing checkout.tsx',
                    previewText: 'Sensitive assistant draft',
                    attentionState: 'thinking',
                    active: true,
                    updatedAt: 1_699_999_980_000,
                },
                sessions: [
                    {
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Improve checkout flow',
                        subtitle: 'happier/app',
                        statusText: 'Editing checkout.tsx',
                        previewText: 'Sensitive assistant draft',
                        attentionState: 'thinking',
                        active: true,
                        updatedAt: 1_699_999_980_000,
                    },
                ],
            }),
            policy: createPolicy({
                showPreviewText: false,
            }),
            isExpanded: false,
        });

        const taskTitleSlide = model.collapsed.slides?.find((slide) => slide.id === 'task_title');
        expect(taskTitleSlide).toMatchObject({
            title: 'Improve checkout flow',
            subtitle: 'happier/app',
        });
        expect(model.collapsed.slides).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ subtitle: 'Sensitive assistant draft' }),
        ]));
    });

    it('adds a bounce transition cue for ready completion collapsed states', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                counts: {
                    unread: 0,
                    permissionRequired: 0,
                    actionRequired: 0,
                    thinking: 0,
                    totalAttention: 0,
                },
                completionStates: [
                    {
                        sessionId: 'session-primary',
                        serverId: 'server-1',
                        title: 'Primary session',
                        summary: 'Turn finished. Open the session to continue.',
                        openActionIdentifier: 'open-session:session-primary',
                        variant: 'turn_complete',
                        autoDismissMs: 15000,
                        sticky: false,
                    },
                ],
                primary: {
                    serverId: 'server-1',
                    sessionId: 'session-primary',
                    title: 'Primary session',
                    subtitle: 'happier/app',
                    statusText: 'Ready',
                    previewText: null,
                    attentionState: 'pending_input',
                    active: false,
                    updatedAt: 1_699_999_999_000,
                },
                sessions: [
                    {
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Primary session',
                        subtitle: 'happier/app',
                        statusText: 'Ready',
                        previewText: null,
                        attentionState: 'pending_input',
                        active: false,
                        updatedAt: 1_699_999_999_000,
                    },
                ],
            }),
            policy: createPolicy(),
            isExpanded: false,
        });

        expect(model.collapsed.slides?.[0]).toMatchObject({
            title: 'Turn finished. Open the session to continue.',
            priority: 'ready',
        });
        expect(model.collapsed.transitionCue).toEqual({
            kind: 'bounce_on_ready',
            phase: 'ready',
            key: JSON.stringify(['ready', 'server-1', 'session-primary', 1699999999000, 0, 0, 1, 0]),
            durationMs: 150,
        });
    });

    it('adds a phase flash transition cue for attention collapsed states', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                generatedAt: 1_700_000_000_000,
                permissionRequests: [
                    {
                        kind: 'permission_request',
                        requestId: 'perm-1',
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Approve command',
                        summary: 'npm test',
                        toolLabel: 'Bash',
                        questionText: null,
                        count: 1,
                        openActionIdentifier: 'open-session:session-primary',
                        allowActionIdentifier: 'session.permission.respond',
                        denyActionIdentifier: 'session.permission.respond',
                        directOptions: [],
                    },
                ],
            }),
            policy: createPolicy(),
            isExpanded: false,
        });

        expect(model.collapsed.transitionCue).toEqual({
            kind: 'phase_flash',
            phase: 'attention',
            key: JSON.stringify(['attention', 'server-1', 'session-primary', 10, 1, 0, 0, 1]),
            durationMs: 150,
        });
    });

    it('keys collapsed transition cues by the exact Home and collision-safe Session tuple', () => {
        const buildKey = (serverId: string, sessionId: string) => buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                primary: {
                    ...createSnapshot().primary!,
                    serverId,
                    sessionId,
                },
                sessions: [{
                    ...createSnapshot().sessions[0]!,
                    serverId,
                    sessionId,
                }],
            }),
            policy: createPolicy(),
            isExpanded: false,
        }).collapsed.transitionCue?.key;

        expect(buildKey('home-a', 'same-session')).not.toBe(buildKey('home-b', 'same-session'));
        expect(buildKey('home:a', 'session')).not.toBe(buildKey('home', 'a:session'));
    });

    it('escalates the collapsed urgency level from unattended attention time', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                generatedAt: 1_700_000_000_000,
                permissionRequests: [
                    {
                        kind: 'permission_request',
                        requestId: 'perm-1',
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Approve command',
                        summary: 'npm test',
                        toolLabel: 'Bash',
                        questionText: null,
                        count: 1,
                        openActionIdentifier: 'open-session:session-primary',
                        allowActionIdentifier: 'session.permission.respond',
                        denyActionIdentifier: 'session.permission.respond',
                        directOptions: [],
                    },
                ],
                primary: {
                    serverId: 'server-1',
                    sessionId: 'session-primary',
                    title: 'Primary session',
                    subtitle: 'agent on machine',
                    statusText: 'Permission required',
                    previewText: null,
                    attentionState: 'permission_required',
                    active: true,
                    updatedAt: 1_699_999_940_000,
                },
                sessions: [
                    {
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Primary session',
                        subtitle: 'agent on machine',
                        statusText: 'Permission required',
                        previewText: null,
                        attentionState: 'permission_required',
                        active: true,
                        updatedAt: 1_699_999_940_000,
                    },
                ],
            }),
            policy: createPolicy(),
            isExpanded: false,
        });

        expect(model.collapsed.urgency).toEqual({
            level: 'critical',
            unattendedMs: 60000,
            pollMs: 5000,
        });
    });

    it('disables carousel rotation from desktop overlay device policy', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy({
                collapsedCarouselEnabled: false,
            }),
            isExpanded: false,
        });

        expect(model.collapsed.carousel).toEqual({
            enabled: false,
            cadenceMs: 3000,
            freezeReason: 'disabled',
        });
    });

    it('surfaces permissions before user questions, quota summaries, and completion cards in priority order', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                permissionRequests: [
                    {
                        kind: 'permission_request',
                        requestId: 'permission-1',
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Approve deployment',
                        summary: 'Deploy to production',
                        toolLabel: 'Deploy',
                        questionText: null,
                        count: 1,
                        openActionIdentifier: 'open-session:session-primary',
                        allowActionIdentifier: 'session.permission.respond',
                        denyActionIdentifier: 'session.permission.respond',
                        directOptions: [],
                    },
                ],
                userQuestions: [
                    {
                        kind: 'user_question',
                        requestId: 'question-1',
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Which deployment target?',
                        summary: 'Choose a target',
                        toolLabel: 'AskUserQuestion',
                        questionText: 'Which deployment target?',
                        count: 1,
                        openActionIdentifier: 'open-session:session-primary',
                        directOptions: [
                            {
                                id: 'production',
                                label: 'Production',
                                description: 'Deploy to production',
                                actionIdentifier: 'session.user_action.answer',
                                answers: [
                                    {
                                        question: 'Which deployment target?',
                                        answer: 'Production',
                                    },
                                ],
                            },
                        ],
                    },
                ],
                quotaSummaries: [
                    {
                        id: 'claude:default',
                        title: 'Claude',
                        summary: '12% remaining',
                    },
                ],
                completionStates: [
                    {
                        sessionId: 'session-primary',
                        serverId: 'server-1',
                        title: 'Primary session',
                        summary: 'Turn finished. Open the session to continue.',
                        openActionIdentifier: 'open-session:session-primary',
                        variant: 'turn_complete',
                        autoDismissMs: 15000,
                        sticky: false,
                    },
                ],
            }),
            policy: createPolicy({
                visibilityMode: 'active_sessions',
            }),
            isExpanded: true,
        });

        expect(model.expanded.cards?.map((card) => card.kind)).toEqual([
            'permission_request',
            'user_question',
            'quota_summary',
            'completion_state',
        ]);
        expect(model.expanded.cards?.[0]).toEqual(expect.objectContaining({
            kind: 'permission_request',
            id: activityInstanceKey(
                { serverId: 'server-1', sessionId: 'session-primary' },
                JSON.stringify(['permission_request', 'permission-1']),
            ),
        }));
        expect(model.expanded.cards?.[1]).toEqual(expect.objectContaining({
            kind: 'user_question',
            id: activityInstanceKey(
                { serverId: 'server-1', sessionId: 'session-primary' },
                JSON.stringify(['user_question', 'question-1']),
            ),
            actions: expect.arrayContaining([
                expect.objectContaining({
                    actionIdentifier: 'session.user_action.answer',
                    data: expect.objectContaining({
                        requestId: 'question-1',
                        sessionId: 'session-primary',
                        serverId: 'server-1',
                    }),
                }),
                expect.objectContaining({
                    id: 'other',
                    inputKind: 'inline_text',
                }),
                expect.objectContaining({
                    actionIdentifier: 'open-session:session-primary',
                }),
            ]),
        }));
        expect(model.expanded.cards).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'quota_summary',
                id: 'quota:claude:default',
            }),
            expect.objectContaining({
                kind: 'completion_state',
                id: activityInstanceKey(
                    { serverId: 'server-1', sessionId: 'session-primary' },
                    'completion',
                ),
                variant: 'turn_complete',
                autoDismissMs: 15000,
                sticky: false,
            }),
        ]));
        expect(model.expanded.cards).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'session_overview' }),
            expect.objectContaining({ kind: 'multi_session_list' }),
        ]));
        expect(model.collapsed.title).toBe('Approve deployment');
        expect(model.collapsed.accentText).toBe('Deploy');
    });

    it('adds low-risk permission always-allow actions while high-risk permissions open for review', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                permissionRequests: [
                    {
                        kind: 'permission_request',
                        requestId: 'perm-low',
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Read package.json',
                        summary: 'Read package.json',
                        toolLabel: 'Read',
                        questionText: null,
                        count: 1,
                        openActionIdentifier: 'open-session:session-primary',
                        allowActionIdentifier: 'session.permission.respond',
                        denyActionIdentifier: 'session.permission.respond',
                        directOptions: [],
                        risk: 'low',
                    },
                    {
                        kind: 'permission_request',
                        requestId: 'perm-high',
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Run deploy.sh',
                        summary: 'Run deploy.sh',
                        toolLabel: 'Bash',
                        questionText: null,
                        count: 1,
                        openActionIdentifier: 'open-session:session-primary',
                        allowActionIdentifier: 'session.permission.respond',
                        denyActionIdentifier: 'session.permission.respond',
                        directOptions: [],
                        risk: 'high',
                    },
                ],
            }),
            policy: createPolicy(),
            isExpanded: true,
        });

        const lowRiskCard = model.expanded.cards?.find((card) => card.kind === 'permission_request' && card.requestId === 'perm-low');
        const highRiskCard = model.expanded.cards?.find((card) => card.kind === 'permission_request' && card.requestId === 'perm-high');

        expect(lowRiskCard).toEqual(expect.objectContaining({
            kind: 'permission_request',
            risk: 'low',
            actions: expect.arrayContaining([
                expect.objectContaining({
                    id: 'always_allow',
                    label: 'Always allow Read',
                    data: expect.objectContaining({ persistence: 'always' }),
                }),
            ]),
        }));
        expect(highRiskCard).toEqual(expect.objectContaining({
            kind: 'permission_request',
            risk: 'high',
            actions: [
                expect.objectContaining({ id: expect.stringContaining('deny') }),
                expect.objectContaining({ id: expect.stringContaining('open') }),
            ],
        }));
        expect(highRiskCard).not.toEqual(expect.objectContaining({
            actions: expect.arrayContaining([
                expect.objectContaining({ id: expect.stringContaining('allow') }),
            ]),
        }));
    });

    it('keeps completion cards distinct when two Homes reuse a session id', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                sessions: [
                    {
                        ...createSnapshot().sessions[0],
                        serverId: 'server-a',
                        sessionId: 'shared-session',
                        title: 'Home A session',
                    },
                    {
                        ...createSnapshot().sessions[0],
                        serverId: 'server-b',
                        sessionId: 'shared-session',
                        title: 'Home B session',
                    },
                ],
                completionStates: [
                    {
                        sessionId: 'shared-session',
                        serverId: 'server-a',
                        title: 'Home A session',
                        summary: 'Ready',
                        openActionIdentifier: 'open-session:shared-session?serverId=server-a',
                        variant: 'turn_complete',
                        autoDismissMs: 15_000,
                        sticky: false,
                    },
                    {
                        sessionId: 'shared-session',
                        serverId: 'server-b',
                        title: 'Home B session',
                        summary: 'Ready',
                        openActionIdentifier: 'open-session:shared-session?serverId=server-b',
                        variant: 'turn_complete',
                        autoDismissMs: 15_000,
                        sticky: false,
                    },
                ],
            }),
            policy: createPolicy({ visibilityMode: 'active_sessions' }),
            isExpanded: true,
        });

        const completionCards = model.expanded.cards?.filter((card) => card.kind === 'completion_state') ?? [];
        expect(completionCards).toHaveLength(2);
        expect(new Set(completionCards.map((card) => card.id)).size).toBe(2);
        expect(completionCards.map((card) => card.id)).toEqual([
            activityInstanceKey(
                { serverId: 'server-a', sessionId: 'shared-session' },
                'completion',
            ),
            activityInstanceKey(
                { serverId: 'server-b', sessionId: 'shared-session' },
                'completion',
            ),
        ]);
        expect(completionCards.map((card) => card.serverId)).toEqual(['server-a', 'server-b']);
    });

    it('keeps an unscoped legacy completion distinct from an exact tuple with colliding JSON text', () => {
        const exactAddress = { serverId: 'server-a', sessionId: 'shared-session' } as const;
        const legacySessionId = sessionAddressKey(exactAddress);
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                completionStates: [
                    {
                        sessionId: exactAddress.sessionId,
                        serverId: exactAddress.serverId,
                        title: 'Exact Home session',
                        summary: 'Ready',
                        openActionIdentifier: 'open-session:shared-session?serverId=server-a',
                        variant: 'turn_complete',
                        autoDismissMs: 15_000,
                        sticky: false,
                    },
                    {
                        sessionId: legacySessionId,
                        serverId: null,
                        title: 'Legacy unscoped session',
                        summary: 'Ready',
                        openActionIdentifier: 'open-session:legacy',
                        variant: 'turn_complete',
                        autoDismissMs: 15_000,
                        sticky: false,
                    },
                ],
            }),
            policy: createPolicy({ visibilityMode: 'active_sessions' }),
            isExpanded: true,
        });

        const completionCards = model.expanded.cards?.filter((card) => card.kind === 'completion_state') ?? [];
        expect(completionCards.map((card) => card.id)).toEqual([
            activityInstanceKey(exactAddress, 'completion'),
            activityInstanceKey({ serverId: null, sessionId: legacySessionId }, 'completion'),
        ]);
        expect(new Set(completionCards.map((card) => card.id)).size).toBe(2);
    });

    it('keys a current session overview by qualified identity, with legacy unscoped identity distinct', () => {
        const buildSessionCardId = (serverId: string | null, sessionId: string) => {
            const model = buildDesktopActivityOverlayModel({
                snapshot: createSnapshot({
                    permissionRequests: [],
                    userQuestions: [],
                    quotaSummaries: [],
                    completionStates: [],
                    sessions: [{
                        ...createSnapshot().sessions[0],
                        serverId,
                        sessionId,
                    }],
                }),
                policy: createPolicy({ visibilityMode: 'active_sessions' }),
                isExpanded: true,
            });
            return model.expanded.cards?.find((card) => card.kind === 'session_overview')?.id;
        };
        const collidingText = sessionAddressKey({ serverId: 'server-a', sessionId: 'shared-session' });

        expect(buildSessionCardId('server-a', 'shared-session')).toBe(
            activityInstanceKey({ serverId: 'server-a', sessionId: 'shared-session' }, 'session'),
        );
        expect(buildSessionCardId('server-a', 'shared-session')).not.toBe(
            buildSessionCardId('server-b', 'shared-session'),
        );
        expect(buildSessionCardId('server-a', collidingText)).not.toBe(
            buildSessionCardId(null, collidingText),
        );
    });

    it('numbers user-question choices and adds inline other for single-question flows', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                userQuestions: [
                    {
                        kind: 'user_question',
                        requestId: 'question-1',
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Which deployment target?',
                        summary: 'Choose a target',
                        toolLabel: 'AskUserQuestion',
                        questionText: 'Which deployment target?',
                        count: 1,
                        openActionIdentifier: 'open-session:session-primary',
                        directOptions: [
                            {
                                id: 'production',
                                label: 'Production',
                                description: null,
                                actionIdentifier: 'session.user_action.answer',
                                answers: [{ question: 'Which deployment target?', answer: 'Production' }],
                            },
                            {
                                id: 'staging',
                                label: 'Staging',
                                description: null,
                                actionIdentifier: 'session.user_action.answer',
                                answers: [{ question: 'Which deployment target?', answer: 'Staging' }],
                            },
                        ],
                    },
                ],
            }),
            policy: createPolicy(),
            isExpanded: true,
        });

        expect(model.expanded.cards?.[0]).toEqual(expect.objectContaining({
            kind: 'user_question',
            actions: [
                expect.objectContaining({ id: 'option-1-production', label: '1. Production' }),
                expect.objectContaining({ id: 'option-2-staging', label: '2. Staging' }),
                expect.objectContaining({ id: 'other', inputKind: 'inline_text' }),
                expect.objectContaining({ id: expect.stringContaining('open') }),
            ],
        }));
    });

    it('does not crash when a legacy user-question snapshot is missing direct options', () => {
        const legacyUserQuestion = {
            kind: 'user_question',
            requestId: 'question-legacy',
            sessionId: 'session-primary',
            title: 'Which deployment target?',
            summary: 'Choose a target',
            toolLabel: 'AskUserQuestion',
            questionText: 'Which deployment target?',
            count: 1,
            openActionIdentifier: 'open-session:session-primary',
        };

        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                userQuestions: [
                    // Boundary fixture: live persisted/bridged payloads can omit fields despite the TS contract.
                    legacyUserQuestion as unknown as DesktopActivityOverlaySnapshot['userQuestions'][number],
                ],
            }),
            policy: createPolicy({
                visibilityMode: 'active_sessions',
            }),
            isExpanded: true,
        });

        expect(model.expanded.cards?.[0]).toEqual(expect.objectContaining({
            kind: 'user_question',
            id: activityInstanceKey(
                { serverId: null, sessionId: 'session-primary' },
                JSON.stringify(['user_question', 'question-legacy']),
            ),
            actions: [
                expect.objectContaining({
                    actionIdentifier: 'open-session:session-primary',
                }),
            ],
        }));
    });

    it('carries quick reply phrases into the expanded overlay model', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                sessions: [
                    {
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Primary session',
                        subtitle: 'agent on machine',
                        statusText: 'Ready',
                        previewText: null,
                        attentionState: 'pending_input',
                        active: true,
                        updatedAt: 10,
                    },
                ],
            }),
            policy: createPolicy({
                quickReplyPhrases: ['Ship', 'Explain'],
            }),
            isExpanded: true,
        });

        expect(model.expanded.quickReply).toEqual({
            targetSessionId: 'session-primary',
            serverId: 'server-1',
            phrases: ['Ship', 'Explain'],
        });
    });

    it('omits quick reply when the target session lacks server scope', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                primary: {
                    serverId: null,
                    sessionId: 'session-primary',
                    title: 'Primary session',
                    subtitle: 'agent on machine',
                    statusText: 'Ready',
                    previewText: null,
                    attentionState: 'pending_input',
                    active: true,
                    updatedAt: 10,
                },
                sessions: [
                    {
                        serverId: null,
                        sessionId: 'session-primary',
                        title: 'Primary session',
                        subtitle: 'agent on machine',
                        statusText: 'Ready',
                        previewText: null,
                        attentionState: 'pending_input',
                        active: true,
                        updatedAt: 10,
                    },
                ],
            }),
            policy: createPolicy({
                quickReplyPhrases: ['Ship', 'Explain'],
            }),
            isExpanded: true,
        });

        expect(model.expanded.quickReply).toBeNull();
    });
});
