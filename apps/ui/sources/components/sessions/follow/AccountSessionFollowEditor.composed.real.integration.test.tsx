import * as React from 'react';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { GetSessionFollowResponseSchema, SetSessionFollowResponseSchema, RemoveSessionFollowResponseSchema } from '@happier-dev/protocol/sessions/follow/api';
import { VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } from '@happier-dev/protocol/sessions/control/contract';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { registerSessionFollowRoutes } from '../../../../../server/sources/app/api/routes/session/registerSessionFollowRoutes';
import { db } from '../../../../../server/sources/storage/db';
import { inTx } from '../../../../../server/sources/storage/inTx';
import { observePendingAccountVoiceFollowInTx } from '../../../../../server/sources/app/session/follow/accountFollowService';
import { resolveSessionFollowFactsInTx } from '../../../../../server/sources/app/session/personal/followFacts';
import { AccountSessionFollowEditor } from './AccountSessionFollowEditor';
import { createAccountSessionFollowController, type AccountSessionFollowTransport } from './accountSessionFollowController';

installSettingsViewCommonModuleMocks();

function presetSegment(screen: Awaited<ReturnType<typeof renderSettingsView>>, preset: string) {
    return screen.tree.root.findAll(node => node.props.testID === `session-follow-policy.preset.${preset}`
        && typeof node.props.onPress === 'function')[0];
}

describe('personal Follow Voice through the mounted editor, HTTP and SQLite', () => {
    let database: LightSqliteHarness;
    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-follow-voice-editor-',
            env: { HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: 'true' } });
    }, 180_000);
    afterAll(async () => { await database?.close(); });

    it('renders modern Voice enable after the server echo and disables the actual runtime selection', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const voice = await db.session.create({ data: { accountId: account.id, tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
            metadata: '{}', encryptionMode: 'plain' } });
        const app = createAuthenticatedTestApp();
        registerSessionFollowRoutes(app);
        await app.ready();
        const request = async (method: 'GET' | 'PUT' | 'DELETE', payload?: unknown) => {
            const response = await app.inject({ method, url: `/v2/sessions/${source.id}/follow`,
                headers: { 'x-test-user-id': account.id }, ...(payload === undefined ? {} : { payload }) });
            expect(response.statusCode, response.body).toBe(200);
            return response.json();
        };
        const transport: AccountSessionFollowTransport = {
            get: async () => ({ kind: 'ok', value: GetSessionFollowResponseSchema.parse(await request('GET')) }),
            set: async (_target, preferences) => ({ kind: 'ok', value: SetSessionFollowResponseSchema.parse(await request('PUT', preferences)) }),
            remove: async () => ({ kind: 'ok', value: RemoveSessionFollowResponseSchema.parse(await request('DELETE')) }),
        };
        const authentication = { env: process.env, authority: 'present_user' as const, authenticationEvidence: undefined };
        const observe = () => inTx(tx => observePendingAccountVoiceFollowInTx(tx, {
            accountId: account.id, voiceSessionId: voice.id, authentication,
            runtimeAuthority: { executionRunId: 'voice-run', occurrenceId: 'voice-occurrence', parentSessionId: voice.id,
                intent: 'voice_agent', runtimeState: 'active_turn' },
        }));
        const controller = createAccountSessionFollowController({ serverId: 'home', sessionId: source.id }, transport);
        let screen: Awaited<ReturnType<typeof renderSettingsView>> | undefined;
        try {
            await request('PUT', { policy: { preset: 'important' } });
            await controller.refresh();
            function Editor() {
                const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
                return <AccountSessionFollowEditor state={state} voiceReadiness="pending" archived={false}
                    onEditPolicy={edit => { void controller.editPolicy(edit); }} onSet={next => { void controller.set(next); }}
                    onRemove={() => { void controller.remove(); }} onRetry={() => { void controller.retry(); }} onOpenNotificationSettings={() => {}} />;
            }
            screen = await renderSettingsView(<Editor />);
            expect(screen.findByTestId('session-follow-voice')?.props.value).toBe(false);
            await act(async () => {
                screen!.findByTestId('session-follow-voice')?.props.onValueChange(true);
                await vi.waitFor(() => expect(controller.getSnapshot().saving).toBe(false));
            });
            // The modern writer deliberately retires the old bit; every reader must use the policy.
            expect(await db.accountSessionFollow.findUniqueOrThrow({ where: { accountId_sessionId: { accountId: account.id, sessionId: source.id } } }))
                .toMatchObject({ includeInVoice: false, followPolicy: JSON.stringify({ preset: 'important', voice: true }) });
            await act(async () => { await controller.refresh(); });
            expect(screen.findByTestId('session-follow-voice')?.props.value).toBe(true);
            expect(screen.findByTestId('session-follow-voice-delivery')).not.toBeNull();
            expect(await inTx(tx => resolveSessionFollowFactsInTx(tx, { accountId: account.id, sessionId: source.id })))
                .toMatchObject({ includeInVoice: true });
            expect(await observe()).toEqual([expect.objectContaining({ sourceSessionId: source.id, policy: { preset: 'important', voice: true } })]);
            await act(async () => {
                screen!.findByTestId('session-follow-voice')?.props.onValueChange(false);
                await vi.waitFor(() => expect(controller.getSnapshot().saving).toBe(false));
            });
            expect(screen.findByTestId('session-follow-voice')?.props.value).toBe(false);
            expect(screen.findByTestId('session-follow-voice-delivery')).toBeNull();
            expect(await observe()).toEqual([]);
            // An unselected Custom event never becomes Voice through a stale legacy bit.
            await request('PUT', { policy: { preset: 'custom', events: { finished: { delivery: 'off', voice: true } } } });
            await db.accountSessionFollow.update({ where: { accountId_sessionId: { accountId: account.id, sessionId: source.id } }, data: { includeInVoice: true } });
            await act(async () => { await controller.refresh(); });
            expect(screen.findByTestId('session-follow-voice')?.props.value).toBe(false);
            expect(await observe()).toEqual([]);
        } finally {
            await screen?.unmount();
            controller.dispose();
            await app.close();
        }
    });

    it('lets an owner suppress delivery, reopen the explicit off state, and restore the policy', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const app = createAuthenticatedTestApp();
        registerSessionFollowRoutes(app);
        await app.ready();
        const request = async (method: 'GET' | 'PUT' | 'DELETE', payload?: unknown) => {
            const response = await app.inject({ method, url: `/v2/sessions/${source.id}/follow`,
                headers: { 'x-test-user-id': account.id }, ...(payload === undefined ? {} : { payload }) });
            expect(response.statusCode, response.body).toBe(200);
            return response.json();
        };
        const transport: AccountSessionFollowTransport = {
            get: async () => ({ kind: 'ok', value: GetSessionFollowResponseSchema.parse(await request('GET')) }),
            set: async (_target, preferences) => ({ kind: 'ok', value: SetSessionFollowResponseSchema.parse(await request('PUT', preferences)) }),
            remove: async () => ({ kind: 'ok', value: RemoveSessionFollowResponseSchema.parse(await request('DELETE')) }),
        };
        const controller = createAccountSessionFollowController({ serverId: 'home', sessionId: source.id }, transport);
        let screen: Awaited<ReturnType<typeof renderSettingsView>> | undefined;
        try {
            await controller.refresh();
            function Editor() {
                const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
                return <AccountSessionFollowEditor state={state} voiceReadiness="eligible" archived={false}
                    onEditPolicy={edit => { void controller.editPolicy(edit); }} onSet={next => { void controller.set(next); }}
                    onRemove={() => { void controller.remove(); }} onRetry={() => { void controller.retry(); }} onOpenNotificationSettings={() => {}} />;
            }
            screen = await renderSettingsView(<Editor />);
            expect(controller.getSnapshot().projection?.isSessionOwner).toBe(true);
            expect(presetSegment(screen, 'important')).toBeDefined();
            expect(screen.findByTestId('session-follow-unfollow')).not.toBeNull();
            await act(async () => {
                screen!.findByTestId('session-follow-unfollow')?.props.onPress();
                await vi.waitFor(() => expect(controller.getSnapshot().saving).toBe(false));
            });
            await act(async () => { await controller.refresh(); });
            expect(controller.getSnapshot().projection).toMatchObject({
                isSessionOwner: true, follow: { following: false, notificationLevel: 'none' },
            });
            expect(presetSegment(screen, 'important')).toBeUndefined();
            expect(screen.findByTestId('session-follow-follow')?.props.disabled).toBe(false);
            await act(async () => {
                screen!.findByTestId('session-follow-follow')?.props.onPress();
                await vi.waitFor(() => expect(controller.getSnapshot().saving).toBe(false));
            });
            await act(async () => { await controller.refresh(); });
            expect(controller.getSnapshot().projection?.follow).toMatchObject({ following: true, notificationLevel: 'important' });
            expect(presetSegment(screen, 'important')).toBeDefined();
        } finally {
            await screen?.unmount();
            controller.dispose();
            await app.close();
        }
    });
});
