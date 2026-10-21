import sharp from 'sharp';
import * as privacyKit from 'privacy-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfilePublishBodyV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { PublicProfilePreparedAtmosphereV1Schema } from '@happier-dev/protocol/account/publicProfileAtmosphere';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import * as files from '@/storage/blob/files';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { changeUsernameInTx } from '@/app/social/usernameUpdate';
import { publicProfileServerDependencies as deps } from './publicProfileDependencies';
import { readPublicProfilePicture, retirePublicProfilePictureInTx, cleanupPublicProfilePictures } from './publicProfilePicture';
import { publishPublicProfile } from './publicProfilePublish';
import { updatePublicProfile } from './publicProfileUpdate';
import { refreshPublicProfile } from './publicProfileRefresh';
import { pausePublicProfile } from './publicProfilePause';
import { unpublishPublicProfile } from './publicProfileUnpublish';
import { readAdmittedPublicProfileDelivery, readPublicProfileDelivery } from './publicProfileRead';

const env = { HAPPIER_PUBLIC_SERVER_URL: 'https://profiles.example.test/prefix',
    HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test', HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: 'Test Home' };

async function pictureFixture(red: number) {
    const pixels = await sharp({ create: { width: 96, height: 48, channels: 3, background: { r: red, g: 83, b: 137 } } }).png().toBuffer();
    const atmosphere = PublicProfilePreparedAtmosphereV1Schema.parse({ source: 'picture', picture: {
        layout: 'horizon', descriptor: { kind: 'photo', title: 'Reviewed copy', credit: null, horizon: {}, focus: {},
            hour: 12, grades: { light: 1, dusk: 1, night: 1 }, dark: 'night', adaptiveHaze: false,
            look: { effect: 'original', params: {}, strength: 1, dissolve: { style: 'gradient', from: 0.58, to: 1 } } },
        content: { mimeType: 'image/png', base64: privacyKit.encodeBase64(pixels) },
    } });
    return { pixels, appearance: { atmosphere, theme: 'auto' as const } };
}

function publishBody(appearance: unknown = DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1) {
    return PublicProfilePublishBodyV1Schema.parse({ policy: structuredClone(DEFAULT_PUBLIC_PROFILE_POLICY_V1), metadata: {}, projectSelections: [],
        query: normalizeUsageQuery({ population: 'public_eligible_personal', period: { startMs: 1000, endMs: 2000 }, timeZoneOffsetMinutes: 0 }),
        snapshot: { v: 1, computedAtMs: 2000, period: { startMs: 1000, endMs: 2000, timeZoneOffsetMinutes: 0 },
            coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: {}, facts: {} },
        layout: { v: 1, items: [] }, appearance });
}

async function publishedAccount() {
    const owner = await db.account.create({ data: { encryptionMode: 'plain', username: 'delivery_owner', name: 'Reviewed owner' } });
    expect((await publishPublicProfile(owner.id, publishBody(), env, deps)).kind).toBe('updated');
    return owner;
}

async function applyPicture(accountId: string, red: number) {
    const fixture = await pictureFixture(red);
    const result = await updatePublicProfile(accountId, { appearance: fixture.appearance });
    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated' || result.record?.appearance?.atmosphere.source !== 'picture') throw new Error('Expected applied picture');
    return { pixels: fixture.pixels, id: result.record.appearance.atmosphere.picture.ref.id };
}

describe('public-profile media admission', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-profile-delivery-', initFiles: true,
        env: { NODE_OPTIONS: [process.env.NODE_OPTIONS, '--conditions=happier-source'].filter(Boolean).join(' ') } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => { vi.restoreAllMocks(); await db.uploadedFile.deleteMany(); await db.account.deleteMany(); });

    it.each(['plain', 'e2ee'] as const)('publishes reviewed picture bytes atomically without changing %s Account keys', async encryptionMode => {
        const owner = await db.account.create({ data: { encryptionMode, username: 'delivery_owner',
            ...(encryptionMode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const fixture = await pictureFixture(17);
        const result = await publishPublicProfile(owner.id, publishBody(fixture.appearance), env, deps);
        expect(result.kind).toBe('updated');
        if (result.kind !== 'updated' || result.record?.appearance?.atmosphere.source !== 'picture') throw new Error('Expected applied picture');
        const pictureId = result.record.appearance.atmosphere.picture.ref.id;
        const physical = await readPublicProfilePicture({ accountId: owner.id, pictureId });
        expect(physical.ok).toBe(true);
        if (!physical.ok) throw new Error('Expected readable committed pixels');
        expect((await sharp(physical.bytes).raw().toBuffer()).equals(await sharp(fixture.pixels).raw().toBuffer())).toBe(true);
        expect(JSON.stringify(result)).not.toContain('base64');
        const facts = publishBody();
        expect((await refreshPublicProfile(owner.id, { query: facts.query, snapshot: facts.snapshot }, env, deps)).kind).toBe('updated');
        const refreshed = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: owner.id } });
        expect(JSON.parse(refreshed.appearanceJson!).atmosphere.picture.ref.id).toBe(pictureId);
        const after = await db.account.findUniqueOrThrow({ where: { id: owner.id } });
        expect(after).toMatchObject({ encryptionMode: owner.encryptionMode, publicKey: owner.publicKey,
            contentPublicKey: owner.contentPublicKey, contentPublicKeySig: owner.contentPublicKeySig });
    });

    it('retires displaced custody after Apply and unpublish and preserves a committed result when deletion fails', async () => {
        const owner = await publishedAccount();
        const first = await applyPicture(owner.id, 17);
        const oldRow = await db.uploadedFile.findUniqueOrThrow({ where: { id: first.id } });
        const deletion = vi.spyOn(files, 'deletePrivateFile').mockRejectedValue(new Error('physical deletion unavailable'));
        const second = await applyPicture(owner.id, 199);
        expect(await readPublicProfilePicture({ accountId: owner.id, pictureId: first.id })).toEqual({ ok: false, reason: 'not_found' });
        expect((await files.readPrivateFile(oldRow.path)).length).toBeGreaterThan(0);
        expect((await readPublicProfilePicture({ accountId: owner.id, pictureId: second.id })).ok).toBe(true);
        deletion.mockRestore();
        await cleanupPublicProfilePictures(owner.id);
        await expect(files.readPrivateFile(oldRow.path)).rejects.toThrow();
        await unpublishPublicProfile(owner.id);
        expect(await readPublicProfilePicture({ accountId: owner.id, pictureId: second.id })).toEqual({ ok: false, reason: 'not_found' });
    });

    it('rejects an Apply that loses admission during physical IO without replacing the prior image', async () => {
        const owner = await publishedAccount();
        const first = await applyPicture(owner.id, 17);
        const fixture = await pictureFixture(199);
        const realWrite = files.writePrivateFile;
        vi.spyOn(files, 'writePrivateFile').mockImplementationOnce(async (path, bytes) => {
            await realWrite(path, bytes);
            await db.accountPublicProfile.update({ where: { accountId: owner.id }, data: { removedAt: new Date(), removalReason: 'operator restriction won' } });
        });
        expect(await updatePublicProfile(owner.id, { appearance: fixture.appearance })).toEqual({ kind: 'unavailable', reason: 'restricted' });
        const current = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: owner.id } });
        expect(JSON.parse(current.appearanceJson!).atmosphere.picture.ref.id).toBe(first.id);
        expect(await db.uploadedFile.findMany({ where: { accountId: owner.id }, select: { id: true } })).toEqual([{ id: first.id }]);
        expect((await readPublicProfilePicture({ accountId: owner.id, pictureId: first.id })).ok).toBe(true);
    });

    it('retains the applied edition when preparing replacement pixels fails', async () => {
        const owner = await publishedAccount();
        const first = await applyPicture(owner.id, 17);
        const fixture = await pictureFixture(199);
        vi.spyOn(files, 'writePrivateFile').mockRejectedValueOnce(new Error('physical write unavailable'));
        expect(await updatePublicProfile(owner.id, { appearance: fixture.appearance })).toEqual({ kind: 'unavailable', reason: 'asset_unavailable' });
        const current = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: owner.id } });
        expect(JSON.parse(current.appearanceJson!).atmosphere.picture.ref.id).toBe(first.id);
        expect(await db.uploadedFile.findMany({ where: { accountId: owner.id }, select: { id: true } })).toEqual([{ id: first.id }]);
    });

    it('retires the same applied custody through canonical username withdrawal', async () => {
        const owner = await publishedAccount();
        const applied = await applyPicture(owner.id, 17);
        await inTx(tx => changeUsernameInTx(tx, owner.id, { kind: 'manual_set', username: 'renamed_owner' }, env), { isolationLevel: 'Serializable' });
        expect(await db.accountPublicProfile.findUnique({ where: { accountId: owner.id } })).toBeNull();
        expect(await readPublicProfilePicture({ accountId: owner.id, pictureId: applied.id })).toEqual({ ok: false, reason: 'not_found' });
    });

    it('returns only the current admitted picture and revokes media on replacement, pause and unpublish', async () => {
        const owner = await publishedAccount();
        const first = await applyPicture(owner.id, 17);
        const delivery = await readAdmittedPublicProfileDelivery('delivery_owner', env, deps);
        expect(delivery.result.kind).toBe('published');
        expect(delivery.picture).toMatchObject({ mimeType: 'image/png', width: 96, height: 48 });
        expect((await sharp(delivery.picture!.bytes).raw().toBuffer()).equals(await sharp(first.pixels).raw().toBuffer())).toBe(true);
        expect(JSON.stringify(delivery.result)).not.toContain(owner.id);
        expect(JSON.stringify(delivery.result)).not.toContain('public-profile/');

        const second = await applyPicture(owner.id, 199);
        const replaced = await readAdmittedPublicProfileDelivery('delivery_owner', env, deps);
        expect(replaced.result).toMatchObject({ kind: 'published', view: { appearance: { atmosphere: {
            source: 'picture', picture: { ref: { kind: 'publication', id: second.id } },
        } } } });
        expect((await sharp(replaced.picture!.bytes).raw().toBuffer()).equals(await sharp(second.pixels).raw().toBuffer())).toBe(true);
        await pausePublicProfile(owner.id);
        expect(await readAdmittedPublicProfileDelivery('delivery_owner', env, deps)).toMatchObject({ result: { kind: 'paused' } });
        expect((await readAdmittedPublicProfileDelivery('delivery_owner', env, deps)).picture).toBeUndefined();
        await unpublishPublicProfile(owner.id);
        expect(await readAdmittedPublicProfileDelivery('delivery_owner', env, deps)).toEqual({ result: { kind: 'unavailable' } });
    });

    it('distinguishes missing custody from a physical storage failure', async () => {
        const owner = await publishedAccount();
        const applied = await applyPicture(owner.id, 17);
        const boundary = vi.spyOn(files, 'readPrivateFile').mockRejectedValue(new Error('physical storage unavailable'));
        await expect(readAdmittedPublicProfileDelivery('delivery_owner', env, deps)).rejects.toThrow();
        boundary.mockRestore();
        await inTx(tx => retirePublicProfilePictureInTx(tx, owner.id, applied.id));
        expect(await readAdmittedPublicProfileDelivery('delivery_owner', env, deps)).toEqual({ result: { kind: 'unavailable' } });
    });

    it('lets current withdrawal supersede a physical read failure for the retired image', async () => {
        const owner = await publishedAccount();
        await applyPicture(owner.id, 17);
        vi.spyOn(files, 'readPrivateFile').mockImplementationOnce(async () => {
            await unpublishPublicProfile(owner.id);
            throw new Error('retired file is no longer available');
        });
        expect(await readAdmittedPublicProfileDelivery('delivery_owner', env, deps)).toEqual({ result: { kind: 'unavailable' } });
    });

    it.each(['pause', 'hide', 'replace', 'rename', 'recycle'] as const)('readmits the current publication after physical IO races with %s', async change => {
        const owner = await publishedAccount();
        await applyPicture(owner.id, 17);
        const realRead = files.readPrivateFile;
        vi.spyOn(files, 'readPrivateFile').mockImplementationOnce(async path => {
            const bytes = await realRead(path);
            if (change === 'pause') await pausePublicProfile(owner.id);
            if (change === 'hide') {
                const policy = structuredClone(DEFAULT_PUBLIC_PROFILE_POLICY_V1);
                policy.fields.name = false;
                await updatePublicProfile(owner.id, { policy });
            }
            if (change === 'replace') await applyPicture(owner.id, 199);
            if (change === 'rename' || change === 'recycle') {
                await inTx(tx => changeUsernameInTx(tx, owner.id, { kind: 'manual_set', username: 'renamed_owner' }, env), { isolationLevel: 'Serializable' });
                if (change === 'recycle') {
                    const replacement = await publishedAccount();
                    await applyPicture(replacement.id, 199);
                }
            }
            return bytes;
        });
        const delivered = await readAdmittedPublicProfileDelivery('delivery_owner', env, deps);
        if (change === 'hide') {
            expect(delivered.result).toMatchObject({ kind: 'published', view: { identity: {} } });
            expect(JSON.stringify(delivered.result)).not.toContain('Reviewed owner');
            expect(delivered.picture).toBeDefined();
        } else {
            expect(delivered.result.kind).toBe(change === 'pause' ? 'paused' : 'unavailable');
            expect(delivered.picture).toBeUndefined();
        }
    });

    it('returns no media when the real capability decision disables publication', async () => {
        const owner = await publishedAccount();
        await applyPicture(owner.id, 17);
        expect(await readPublicProfileDelivery('delivery_owner', { ...env, HAPPIER_BUILD_FEATURES_DENY: 'account.publicProfiles' }, deps))
            .toEqual({ result: { kind: 'unavailable' } });
    });
});
