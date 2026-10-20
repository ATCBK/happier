import { describe, expect, it } from 'vitest';

import { createSessionAccessFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import { readSessionFollowHeaderPreset } from './sessionFollowHeaderPreset';

describe('Session header Follow chip summary', () => {
    it('names the effective personal level from the synced viewer facts, owner default included', () => {
        const owner = createSessionAccessFixture('owner');
        const recipient = createSessionAccessFixture('edit');
        // A Session owner with no stored choice is tracked at Important by the Home.
        expect(readSessionFollowHeaderPreset({ access: owner, viewer: createSessionViewerFixture() })).toBe('important');
        // Explicit suppression still tracks the owner, but switches delivery off.
        expect(readSessionFollowHeaderPreset({ access: owner, viewer: createSessionViewerFixture({
            follow: { follows: false, notificationLevel: 'none' },
        }) })).toBe('none');
        // A recipient with no Follow hears nothing: the chip offers Follow.
        expect(readSessionFollowHeaderPreset({ access: recipient, viewer: createSessionViewerFixture() })).toBe('none');
        // A stored policy wins over the legacy level.
        expect(readSessionFollowHeaderPreset({ access: recipient, viewer: createSessionViewerFixture({
            follow: { follows: true, notificationLevel: 'important', policy: { preset: 'quiet' } },
        }) })).toBe('quiet');
        // A malformed current projection is unknown, never a claimed level.
        expect(readSessionFollowHeaderPreset({ access: owner, viewer: { follow: 'broken' } })).toBeNull();
    });
});
