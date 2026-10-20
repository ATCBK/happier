import { z } from 'zod/mini';

import type {
    ReleaseNotesAssetIndex,
    ReleaseNotesManifest,
} from './types';
import {
    STORY_DECK_LIST_CARD_MAX_ROWS,
    STORY_DECK_MAX_CARDS,
} from './storyDeckCardLimits';

const TranslationKeySchema = z.string().check(z.minLength(1), z.maxLength(200));
const IconIdSchema = z.string().check(z.minLength(1), z.maxLength(80));
const ReleaseIdSchema = z.string().check(z.minLength(1), z.maxLength(120));
const AssetKeySchema = z.string().check(z.minLength(1), z.maxLength(200));
const UrlSchema = z.string().check(z.minLength(1), z.maxLength(4000));

const ImageMediaOverrideSchema = z.object({
    localAssetKey: z.optional(AssetKeySchema),
    key: z.optional(AssetKeySchema),
    altKey: z.optional(TranslationKeySchema),
    primaryUrl: z.optional(UrlSchema),
    fallbackUrl: z.optional(UrlSchema),
    url: z.optional(UrlSchema),
}).check(z.superRefine((media, ctx) => {
    if (media.localAssetKey || media.key || media.primaryUrl || media.url) return;
    ctx.addIssue({
        code: "custom",
        message: 'Image media override must include localAssetKey, key, primaryUrl, or url.',
        path: ['key'],
    });
}));

const ImageMediaSchema = z.object({
    localAssetKey: z.optional(AssetKeySchema),
    key: z.optional(AssetKeySchema),
    altKey: TranslationKeySchema,
    primaryUrl: z.optional(UrlSchema),
    fallbackUrl: z.optional(UrlSchema),
    url: z.optional(UrlSchema),
    mobile: z.optional(ImageMediaOverrideSchema),
    desktop: z.optional(ImageMediaOverrideSchema),
}).check(z.superRefine((media, ctx) => {
    if (media.localAssetKey || media.key || media.primaryUrl || media.url) return;
    ctx.addIssue({
        code: "custom",
        message: 'Image media must include localAssetKey, key, primaryUrl, or url.',
        path: ['key'],
    });
}));

const VideoMediaOverrideSchema = z.object({
    key: z.optional(AssetKeySchema),
    localPosterAssetKey: z.optional(AssetKeySchema),
    posterKey: z.optional(AssetKeySchema),
    accessibilityLabelKey: z.optional(TranslationKeySchema),
    primaryUrl: z.optional(UrlSchema),
    fallbackUrl: z.optional(UrlSchema),
    posterUrl: z.optional(UrlSchema),
    posterFallbackUrl: z.optional(UrlSchema),
    loop: z.optional(z.boolean()),
    muted: z.optional(z.boolean()),
}).check(z.superRefine((media, ctx) => {
    if (
        media.key
        || media.localPosterAssetKey
        || media.posterKey
        || media.primaryUrl
        || media.fallbackUrl
        || media.posterUrl
        || media.posterFallbackUrl
    ) return;
    ctx.addIssue({
        code: "custom",
        message: 'Video media override must include a video or poster source.',
        path: ['key'],
    });
}));

const VideoMediaSchema = z.object({
    key: AssetKeySchema,
    localPosterAssetKey: z.optional(AssetKeySchema),
    posterKey: z.optional(AssetKeySchema),
    accessibilityLabelKey: TranslationKeySchema,
    primaryUrl: z.optional(UrlSchema),
    fallbackUrl: z.optional(UrlSchema),
    posterUrl: z.optional(UrlSchema),
    posterFallbackUrl: z.optional(UrlSchema),
    loop: z.optional(z.boolean()),
    muted: z.optional(z.boolean()),
    mobile: z.optional(VideoMediaOverrideSchema),
    desktop: z.optional(VideoMediaOverrideSchema),
}).check(z.superRefine((media, ctx) => {
    if (media.localPosterAssetKey || media.posterKey || media.posterUrl) return;
    ctx.addIssue({
        code: "custom",
        message: 'Video media must include localPosterAssetKey, posterKey, or posterUrl.',
        path: ['posterKey'],
    });
}));

const ListCardSchema = z.object({
    kind: z.literal('list'),
    titleKey: TranslationKeySchema,
    wideTitleKey: z.optional(TranslationKeySchema),
    rows: z.array(z.object({
        iconId: IconIdSchema,
        titleKey: TranslationKeySchema,
        bodyKey: TranslationKeySchema,
    })).check(z.minLength(1), z.maxLength(STORY_DECK_LIST_CARD_MAX_ROWS)),
});

const ImageCardSchema = z.object({
    kind: z.literal('image'),
    titleKey: TranslationKeySchema,
    wideTitleKey: z.optional(TranslationKeySchema),
    bodyKey: TranslationKeySchema,
    media: ImageMediaSchema,
});

const VideoCardSchema = z.object({
    kind: z.literal('video'),
    titleKey: TranslationKeySchema,
    wideTitleKey: z.optional(TranslationKeySchema),
    bodyKey: TranslationKeySchema,
    media: VideoMediaSchema,
});

export const StoryDeckCardSchema = z.discriminatedUnion('kind', [
    ListCardSchema,
    ImageCardSchema,
    VideoCardSchema,
]);

export const ReleaseNotesReleaseSchema = z.object({
    releaseId: ReleaseIdSchema,
    versionLabel: z.string().check(z.minLength(1), z.maxLength(40)),
    publishedAt: z.string().check(z.minLength(1), z.maxLength(64)),
    titleKey: TranslationKeySchema,
    subtitleKey: z.optional(TranslationKeySchema),
    cards: z.array(StoryDeckCardSchema).check(z.minLength(1), z.maxLength(STORY_DECK_MAX_CARDS)),
    actions: z.optional(z.object({
        viewFullReleaseNotes: z.optional(z.boolean()),
    })),
});

export const ReleaseNotesManifestSchema = z.object({
    schemaVersion: z.literal('v1'),
    latestReleaseId: z.nullable(ReleaseIdSchema),
    generatedAt: z.string().check(z.minLength(1)),
    assetBaseUrl: z.string().check(z.minLength(1)),
    releases: z.array(ReleaseNotesReleaseSchema),
});

export const ReleaseNotesAssetIndexEntrySchema = z.object({
    assetKey: AssetKeySchema,
    releaseId: ReleaseIdSchema,
    path: z.string().check(z.minLength(1)),
    fileName: z.string().check(z.minLength(1)),
    sha256: z.string().check(z.minLength(1)),
    contentType: z.string().check(z.minLength(1)),
    sizeBytes: z.number().check(z.int(), z.nonnegative()),
});

export const ReleaseNotesAssetIndexSchema = z.object({
    schemaVersion: z.literal('v1'),
    generatedAt: z.string().check(z.minLength(1)),
    assetsBaseUrl: z.string().check(z.minLength(1)),
    assets: z.record(AssetKeySchema, ReleaseNotesAssetIndexEntrySchema),
});

export function parseReleaseNotesManifest(raw: unknown): ReleaseNotesManifest | null {
    const result = ReleaseNotesManifestSchema.safeParse(raw);
    if (!result.success) {
        return null;
    }
    return result.data as ReleaseNotesManifest;
}

export function parseReleaseNotesAssetIndex(raw: unknown): ReleaseNotesAssetIndex | null {
    const result = ReleaseNotesAssetIndexSchema.safeParse(raw);
    if (!result.success) {
        return null;
    }
    return result.data as ReleaseNotesAssetIndex;
}
