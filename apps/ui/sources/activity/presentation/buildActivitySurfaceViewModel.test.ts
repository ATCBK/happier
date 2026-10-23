import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';

import { buildActivitySurfaceViewModel } from './buildActivitySurfaceViewModel';

describe('buildActivitySurfaceViewModel', () => {
    it('uses the admitted candidate word without reintroducing filtered viewer news', () => {
        const session = createSessionFixture({ active: true, activeAt: 1_000, encryptionMode: 'plain',
            viewer: {
                readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 1 },
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                follow: { follows: false, notificationLevel: null },
                notification: { level: 'important', source: 'owner' },
                attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'full' },
            },
        });
        const candidate = buildSessionActivityAttention({ session, nowMs: 1_000, sessionOptions: { showUnread: false } });
        const view = buildActivitySurfaceViewModel({ candidate,
            policy: resolveActivitySurfacePolicy({ activitySurfacePrivacyMode: 'include_preview' }),
            showMachinePath: false, showPreviewText: false, isPrimary: true, nowMs: 1_000,
        });
        expect(view.statusText).toBe(candidate.workStatus.word);
    });
    it.each([
        { encryptionMode: 'plain', encryptedContentAvailability: 'ready', presentation: 'status_only' },
        { encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_access_pending', presentation: 'full' },
        { encryptionMode: 'e2ee', encryptedContentAvailability: undefined, presentation: 'full' },
    ] as const)('carries privacy-safe structural context through $encryptionMode / $encryptedContentAvailability / $presentation presentation', ({
        encryptionMode, encryptedContentAvailability, presentation,
    }) => {
        const session = createSessionFixture({
            encryptionMode,
            encryptedContentAvailability,
            metadata: {
                path: '/private/PRIVATE-WORKSPACE-SENTINEL',
                host: 'PRIVATE-HOST-SENTINEL',
                summary: { text: 'PRIVATE-TITLE-SENTINEL', updatedAt: 1 },
            },
            viewer: {
                readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 1 },
                relevance: { relevant: true, reasons: ['responsible_for_me'] },
                follow: { follows: true, notificationLevel: 'important' },
                notification: { level: 'important', source: 'preference' },
                attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation },
            },
        });
        const safeContext = 'Home B · Offline · Last updated 18m ago · Developers · Assigned to you · Encrypted access pending';
        const candidate = {
            ...buildSessionActivityAttention({ session, nowMs: 1_000 }),
            context: {
                address: { serverId: 'home-b', sessionId: session.id },
                segments: [
                    { kind: 'home' as const, label: 'Home B' },
                    { kind: 'freshness' as const, label: 'Offline' },
                    { kind: 'freshness' as const, label: 'Last updated 18m ago' },
                    { kind: 'audience' as const, label: 'Developers' },
                    { kind: 'responsibility' as const, label: 'Assigned to you' },
                    { kind: 'content_availability' as const, label: 'Encrypted access pending' },
                    { kind: 'workspace' as const, label: '~/PRIVATE-WORKSPACE-SENTINEL' },
                ],
                contextLine: `${safeContext} · ~/PRIVATE-WORKSPACE-SENTINEL`,
                accessibilityContext: `${safeContext} · ~/PRIVATE-WORKSPACE-SENTINEL`,
                workspace: { label: '~/PRIVATE-WORKSPACE-SENTINEL' },
                mayShowDecryptedContent: false,
            },
        };

        const view = buildActivitySurfaceViewModel({
            candidate,
            policy: resolveActivitySurfacePolicy({ activitySurfacePrivacyMode: 'include_preview' }),
            showMachinePath: true,
            showPreviewText: true,
            isPrimary: true,
            nowMs: 1_000,
        });

        expect(view.contextLine).toBe(safeContext);
        expect(JSON.stringify(view)).not.toContain('PRIVATE-WORKSPACE-SENTINEL');
        expect(JSON.stringify(view)).not.toContain('PRIVATE-TITLE-SENTINEL');
        expect(JSON.stringify(view)).not.toContain('PRIVATE-HOST-SENTINEL');
    });

    it('does not re-read retained metadata after an unknown E2EE candidate is sanitized', () => {
        const session = createSessionFixture({
            encryptionMode: 'e2ee',
            encryptedContentAvailability: undefined,
            metadata: {
                path: '/private/retained/path',
                host: 'private-host',
                summary: { text: 'Private retained title', updatedAt: 1 },
            },
        });
        const candidate = {
            ...buildSessionActivityAttention({ session, nowMs: 1_000 }),
            title: 'Session',
            subtitle: '',
        };

        const view = buildActivitySurfaceViewModel({
            candidate,
            policy: resolveActivitySurfacePolicy({ activitySurfacePrivacyMode: 'include_preview' }),
            showMachinePath: true,
            showPreviewText: true,
            isPrimary: true,
            nowMs: 1_000,
        });

        expect(view.title).toBe('Session');
        expect(view.subtitle).toBeNull();
        expect(view.previewText).toBeNull();
    });

    it('never upgrades a locked viewer to content previews through device policy', () => {
        const session = createSessionFixture({
            encryptionMode: 'plain',
            metadata: { path: '/private/path', host: 'private-host', summary: { text: 'Private title', updatedAt: 1 } },
            viewer: {
                readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 1 },
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                follow: { follows: false, notificationLevel: null },
                notification: { level: 'important', source: 'owner' },
                attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'status_only' },
            },
        });
        const view = buildActivitySurfaceViewModel({
            candidate: buildSessionActivityAttention({ session, nowMs: 1_000 }),
            policy: resolveActivitySurfacePolicy({ activitySurfacePrivacyMode: 'include_preview' }),
            showMachinePath: true, showPreviewText: true, isPrimary: true, nowMs: 1_000,
        });
        expect(view.title).not.toContain('Private');
        expect(view.subtitle).toBeNull();
        expect(view.previewText).toBeNull();
    });

    it('uses the status text as the title in status-only privacy mode', () => {
        const candidate = buildSessionActivityAttention({
            session: createSessionFixture({
                encryptionMode: 'plain',
                id: 'permission',
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 3 },
                },
            }),
            nowMs: 1_000,
        });

        const viewModel = buildActivitySurfaceViewModel({
            candidate,
            policy: resolveActivitySurfacePolicy({
                activitySurfacePrivacyMode: 'status_only',
            }),
            showMachinePath: true,
            showPreviewText: true,
            isPrimary: true,
            nowMs: 1_000,
        });

        expect(viewModel.title).not.toBe('Permission work');
        expect(viewModel.subtitle).toBeNull();
        expect(viewModel.statusText).toBeNull();
    });

    it('exposes preview text and session default targets from the canonical shared view model', () => {
        const candidate = buildSessionActivityAttention({
            session: createSessionFixture({
                encryptionMode: 'plain',
                id: 'permission',
                updatedAt: 1_234,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: '  Need\n\n your   approval  ', updatedAt: 3 },
                },
            }),
            nowMs: 1_000,
        });

        const viewModel = buildActivitySurfaceViewModel({
            candidate,
            policy: resolveActivitySurfacePolicy({
                activitySurfacePrivacyMode: 'include_preview',
            }),
            showMachinePath: true,
            showPreviewText: true,
            isPrimary: true,
            nowMs: 1_000,
        });

        expect(viewModel.previewText).toBe('Need your approval');
        expect(viewModel.defaultTarget).toBe('open-session:permission');
        expect(viewModel.updatedAt).toBe(1_234);
    });

    it('hides preview text without stripping non-sensitive status text when previews are disabled', () => {
        const candidate = buildSessionActivityAttention({
            session: createSessionFixture({
                encryptionMode: 'plain',
                id: 'permission',
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Need your approval', updatedAt: 3 },
                },
            }),
            nowMs: 1_000,
        });

        const viewModel = buildActivitySurfaceViewModel({
            candidate,
            policy: resolveActivitySurfacePolicy({
                activitySurfacePrivacyMode: 'include_preview',
            }),
            showMachinePath: true,
            showPreviewText: false,
            isPrimary: true,
            nowMs: 1_000,
        });

        expect(viewModel.previewText).toBeNull();
        expect(viewModel.statusText).toBeTruthy();
    });
});
