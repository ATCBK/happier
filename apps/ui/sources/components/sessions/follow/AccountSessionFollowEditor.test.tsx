import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { GetSessionFollowResponse } from '@happier-dev/protocol';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { t } from '@/text';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

import { AccountSessionFollowEditor } from './AccountSessionFollowEditor';
import { createAccountSessionFollowController, type AccountSessionFollowTransport } from './accountSessionFollowController';

installSettingsViewCommonModuleMocks();

describe('Account Follow editor', () => {
    it('presents a scope refusal with the existing denial notice and disabled controls', async () => {
        const screen = await renderSettingsView(<AccountSessionFollowEditor state={{
            projection: null, draft: null, loading: false, saving: false, online: true,
            error: 'credential_scope_denied', voiceInitialSnapshotPending: false,
        }} voiceReadiness="eligible" archived={false} onSet={() => {}} onRemove={() => {}}
            onRetry={() => {}} onOpenNotificationSettings={() => {}} />);
        expect(screen.getTextContent()).toContain(t('errors.permissionDenied'));
        expect(screen.findByTestId('session-follow-enabled')?.props.disabled).toBe(true);
        await screen.unmount();
    });
    it('creates, updates, unfollows, and refollows through the mounted editor', async () => {
        const address = { serverId: 'home-a', sessionId: 'session-a' };
        let stored: GetSessionFollowResponse['follow'] = null;
        const writes: string[] = [];
        const transport: AccountSessionFollowTransport = {
            get: async () => ({ kind: 'ok', value: {
                follow: stored,
                isSessionOwner: false,
                capabilities: { manageFollow: true },
                voiceInitialSnapshotPending: stored?.following === true && stored.includeInVoice,
            } }),
            set: async (target, preferences) => {
                writes.push(`set:${preferences.notificationLevel}`);
                stored = { sessionId: target.sessionId, following: true, ...preferences };
                return { kind: 'ok', value: {
                    changed: true,
                    follow: stored,
                    voiceInitialSnapshotPending: preferences.includeInVoice,
                } };
            },
            remove: async (target) => {
                writes.push('remove');
                stored = {
                    sessionId: target.sessionId,
                    following: false,
                    notificationLevel: 'none',
                    includeInVoice: false,
                };
                return { kind: 'ok', value: { changed: true } };
            },
        };
        const controller = createAccountSessionFollowController(address, transport);
        await controller.refresh();
        function Editor() {
            const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
            return <AccountSessionFollowEditor state={state} voiceReadiness="eligible" archived={false}
                onSet={(next) => { void controller.set(next); }} onRemove={() => { void controller.remove(); }}
                onRetry={() => { void controller.retry(); }} onOpenNotificationSettings={() => {}} />;
        }
        const screen = await renderSettingsView(<Editor />);

        await act(async () => { screen.findByTestId('session-follow-enabled')?.props.onValueChange(true); });
        expect(screen.findByTestId('session-follow-level-important')?.props.accessibilityState?.checked).toBe(true);
        await act(async () => { screen.findByTestId('session-follow-level-all_messages')?.props.onPress(); });
        expect(screen.findByTestId('session-follow-level-all_messages')?.props.accessibilityState?.checked).toBe(true);
        await act(async () => { screen.findByTestId('session-follow-enabled')?.props.onValueChange(false); });
        expect(screen.findByTestId('session-follow-enabled')?.props.value).toBe(false);
        await act(async () => { screen.findByTestId('session-follow-enabled')?.props.onValueChange(true); });
        expect(screen.findByTestId('session-follow-level-important')?.props.accessibilityState?.checked).toBe(true);
        expect(writes).toEqual(['set:important', 'set:all_messages', 'remove', 'set:important']);
        await screen.unmount();
    });

    it('chooses the notification level with a segmented control on a page', async () => {
        const onSet = vi.fn();
        const screen = await renderSettingsView(
            <ListPresentationProvider value="page">
                <AccountSessionFollowEditor state={{
                    projection: { follow: { sessionId: 'session-a', following: true, notificationLevel: 'important', includeInVoice: true }, isSessionOwner: false, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false },
                    draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
                }} voiceReadiness="eligible" archived={false} onSet={onSet}
                onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}} />
            </ListPresentationProvider>,
        );

        expect(screen.findByTestId('session-follow-level-important')).toBeNull();
        await screen.pressByTestIdAsync('session-follow-level:all_messages');
        expect(onSet).toHaveBeenCalledWith({ notificationLevel: 'all_messages', includeInVoice: true });
        await screen.unmount();
    });

    it('moves keyboard focus and the selected notification option together without changing Voice inclusion', async () => {
        const focused = vi.fn();
        function Editor() {
            const [notificationLevel, setLevel] = React.useState<'none' | 'important' | 'all_messages'>('important');
            return <AccountSessionFollowEditor state={{
                projection: { follow: { sessionId: 'session-a', following: true, notificationLevel, includeInVoice: true }, isSessionOwner: false, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }} voiceReadiness="eligible" archived={false} onSet={(next) => {
                expect(next.includeInVoice).toBe(true);
                setLevel(next.notificationLevel);
            }} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}} />;
        }
        const screen = await renderSettingsView(<Editor />, {
            createNodeMock: (element) => ({
                focus: () => focused((element.props as { testID?: string }).testID),
            }),
        });
        const current = screen.findByTestId('session-follow-level-important');
        const event = { key: 'ArrowDown', nativeEvent: { key: 'ArrowDown' }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
        await act(async () => { current?.props.onKeyDown?.(event); });
        expect(event.preventDefault).toHaveBeenCalled();
        expect(screen.findByTestId('session-follow-level-all_messages')?.props['aria-checked']).toBe(true);
        expect(screen.findByTestId('session-follow-level-important')?.props['aria-checked']).toBe(false);
        expect(focused).toHaveBeenCalledWith('session-follow-level-all_messages');
        await screen.unmount();
    });
    it('keeps a selected notification level when Voice is enabled and exposes one radio selection', async () => {
        const address = { serverId: 'home-a', sessionId: 'session-a' };
        const transport: AccountSessionFollowTransport = {
            get: async () => ({ kind: 'ok', value: {
                follow: { sessionId: address.sessionId, following: true, notificationLevel: 'none', includeInVoice: false },
                isSessionOwner: false,
                capabilities: { manageFollow: true },
                voiceInitialSnapshotPending: false,
            } }),
            set: async (target, preferences) => ({ kind: 'ok', value: {
                changed: true, follow: { sessionId: target.sessionId, following: true, ...preferences },
                voiceInitialSnapshotPending: preferences.includeInVoice,
            } }),
            remove: async () => ({ kind: 'ok', value: { changed: true } }),
        };
        const controller = createAccountSessionFollowController(address, transport);
        await controller.refresh();
        function Editor() {
            const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
            // `AccountSessionFollowControl` derives readiness from this same snapshot
            // field, so hard-coding `eligible` here would assert a state the Home has
            // just contradicted by reporting the initial snapshot as pending.
            return <AccountSessionFollowEditor state={state}
                voiceReadiness={state.voiceInitialSnapshotPending ? 'pending' : 'eligible'} archived={false}
                onSet={(next) => { void controller.set(next); }} onRemove={() => { void controller.remove(); }}
                onRetry={() => { void controller.retry(); }} onOpenNotificationSettings={() => {}} />;
        }
        const screen = await renderSettingsView(<Editor />);
        expect(screen.findByTestId('session-follow-level-none')?.props.accessibilityState?.checked).toBe(true);
        await act(async () => { screen.findByTestId('session-follow-voice')?.props.onValueChange(true); });
        // The first flush commits the optimistic draft; the settled Home projection
        // arrives on the following one, and only it carries the pending-snapshot fact.
        await act(async () => {});
        expect(controller.getSnapshot().projection?.follow).toMatchObject({ notificationLevel: 'none', includeInVoice: true });
        expect(screen.findByTestId('session-follow-voice-delivery')).not.toBeNull();
        expect(screen.getTextContent()).toContain(t('session.follow.voice.initialSnapshotPending'));
        await screen.unmount();
    });

    it('projects the Session owner as tracked with the Important default and no interest toggle', async () => {
        const onSet = vi.fn();
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                // No stored row: the Home still tracks the owner and treats them as
                // Important-eligible, so an Off switch would be a false statement.
                projection: { follow: null, isSessionOwner: true, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="eligible" archived={false} onSet={onSet} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}}
        />);
        expect(screen.findByTestId('session-follow-enabled')).toBeNull();
        expect(screen.findByTestId('session-follow-owner-row')).not.toBeNull();
        expect(screen.findByTestId('session-follow-level-important')?.props.accessibilityState?.checked).toBe(true);
        // The selector is the owner's override, and it writes a real preference row.
        expect(screen.findByTestId('session-follow-level-none')?.props.disabled).not.toBe(true);
        await act(async () => { screen.findByTestId('session-follow-level-none')?.props.onPress(); });
        expect(onSet).toHaveBeenCalledWith({ notificationLevel: 'none', includeInVoice: false });
        await screen.unmount();
    });

    it('shows a non-owner with no stored choice as not following', async () => {
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                projection: { follow: null, isSessionOwner: false, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="eligible" archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}}
        />);
        expect(screen.findByTestId('session-follow-enabled')?.props.value).toBe(false);
        expect(screen.findByTestId('session-follow-level-important')).toBeNull();
        await screen.unmount();
    });

    it('leaves explicit Unfollow available for an archived Session and disables preference edits offline', async () => {
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                projection: {
                    follow: { sessionId: 'session-a', following: true, notificationLevel: 'important', includeInVoice: true },
                    isSessionOwner: false,
                    capabilities: { manageFollow: true },
                    voiceInitialSnapshotPending: false,
                },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="eligible" archived onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}}
        />);
        expect(screen.findByTestId('session-follow-enabled')?.props.disabled).toBe(false);
        expect(screen.findByTestId('session-follow-voice')?.props.disabled).toBe(true);
        expect(screen.findByTestId('session-follow-level-important')?.props.disabled).toBe(true);
        await screen.unmount();
    });

    it('does not allow a non-owner to start following an archived Session', async () => {
        const onSet = vi.fn();
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                projection: {
                    follow: null,
                    isSessionOwner: false,
                    capabilities: { manageFollow: true },
                    voiceInitialSnapshotPending: false,
                },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="eligible"
            archived
            onSet={onSet}
            onRemove={() => {}}
            onRetry={() => {}}
            onOpenNotificationSettings={() => {}}
        />);

        const toggle = screen.findByTestId('session-follow-enabled');
        expect(toggle?.props.value).toBe(false);
        expect(toggle?.props.disabled).toBe(true);
        await act(async () => { toggle?.props.onValueChange(true); });
        expect(onSet).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('does not expose an enabled mutation control when the Home denies Follow management', async () => {
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                projection: {
                    follow: { sessionId: 'session-a', following: true, notificationLevel: 'important', includeInVoice: false },
                    isSessionOwner: false,
                    capabilities: { manageFollow: false },
                    voiceInitialSnapshotPending: false,
                },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="eligible" archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}}
        />);
        expect(screen.findByTestId('session-follow-enabled')?.props.disabled).toBe(true);
        expect(screen.findByTestId('session-follow-level-important')?.props.disabled).toBe(true);
        await screen.unmount();
    });

    it('renders the readiness selected by the canonical Voice runtime projection', async () => {
        const state = {
            projection: {
                follow: { sessionId: 'session-a', following: true, notificationLevel: 'important' as const, includeInVoice: true },
                isSessionOwner: false,
                capabilities: { manageFollow: true },
                voiceInitialSnapshotPending: false,
            },
            draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
        };
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={state}
            voiceReadiness="waiting_encrypted"
            archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}}
        />);
        expect(screen.getTextContent()).toContain(t('session.follow.voice.waitingEncrypted'));
        await screen.unmount();
    });

    it('describes eligible Voice inclusion as Voice context rather than generic Account following', async () => {
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                projection: {
                    follow: { sessionId: 'session-a', following: true, notificationLevel: 'important', includeInVoice: true },
                    isSessionOwner: false,
                    capabilities: { manageFollow: true },
                    voiceInitialSnapshotPending: false,
                },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="eligible"
            archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}}
        />);
        expect(screen.getTextContent()).toContain(t('session.follow.voice.subtitle'));
        await screen.unmount();
    });

    it('states nominal Voice delivery once instead of repeating the row subtitle beneath itself', async () => {
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                projection: {
                    follow: { sessionId: 'session-a', following: true, notificationLevel: 'important', includeInVoice: true },
                    isSessionOwner: false,
                    capabilities: { manageFollow: true },
                    voiceInitialSnapshotPending: false,
                },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="eligible"
            archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}}
        />);
        // The row subtitle already says what Voice inclusion does. A status row is
        // only worth its vertical space when it reports something the subtitle does
        // not, so the nominal case must not print the same sentence twice in a row.
        const subtitle = t('session.follow.voice.subtitle');
        const occurrences = screen.getTextContent().split(subtitle).length - 1;
        expect(occurrences).toBe(1);
        expect(screen.findByTestId('session-follow-voice-delivery')).toBeNull();
        await screen.unmount();
    });

    it('explains provider withholding without turning off Voice inclusion', async () => {
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                projection: {
                    follow: { sessionId: 'session-a', following: true, notificationLevel: 'important', includeInVoice: true },
                    isSessionOwner: false,
                    capabilities: { manageFollow: true },
                    voiceInitialSnapshotPending: false,
                },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="provider_withheld"
            archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}}
        />);
        expect(screen.findByTestId('session-follow-voice')?.props.value).toBe(true);
        expect(screen.getTextContent()).toContain(t('session.follow.voice.providerWithheld'));
        await screen.unmount();
    });

    it('explains that a followed external Session with Background sync off may only update while attached', async () => {
        const state = {
            projection: {
                follow: { sessionId: 'session-a', following: true, notificationLevel: 'important' as const, includeInVoice: false },
                isSessionOwner: false,
                capabilities: { manageFollow: true },
                voiceInitialSnapshotPending: false,
            },
            draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
        };
        const quiet = await renderSettingsView(<AccountSessionFollowEditor
            state={state}
            voiceReadiness="eligible"
            archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}}
        />);
        // A Session whose Background sync is on promises nothing extra, so the
        // explanation must not appear there.
        expect(quiet.findByTestId('session-follow-external-attached-only')).toBeNull();
        await quiet.unmount();

        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={state}
            voiceReadiness="eligible"
            externalBackgroundSyncOff
            archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}}
        />);
        expect(screen.findByTestId('session-follow-external-attached-only')).not.toBeNull();
        expect(screen.getTextContent()).toContain(t('session.follow.editor.externalAttachedOnly'));
        // It explains a consequence of the external source's acquisition; it is
        // not a second Follow control and changes nothing the person chose.
        expect(screen.findByTestId('session-follow-enabled')?.props.value).toBe(true);
        expect(screen.findByTestId('session-follow-level-important')?.props.accessibilityState?.checked).toBe(true);
        await screen.unmount();
    });
});
