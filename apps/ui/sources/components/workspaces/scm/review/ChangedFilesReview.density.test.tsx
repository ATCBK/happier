import type * as React from 'react';
import { expect, it } from 'vitest';

import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { resolveThemeStyleScales } from '@/theme/themeStyleScales';
import { areChangedFilesReviewPropsEqual, ChangedFilesReview } from './ChangedFilesReview';

it('admits compact density changes while retaining equivalent review spacing', () => {
    const theme = createThemeFixture();
    const props = {
        theme,
        sessionId: 'density-review',
        snapshot: null,
        changedFilesViewMode: 'repository',
        allRepositoryChangedFiles: [],
        sessionAttributedFiles: [],
        repositoryOnlyFiles: [],
        maxFiles: 25,
        maxChangedLines: 1000,
        onFilePress: () => {},
    } satisfies React.ComponentProps<typeof ChangedFilesReview>;

    expect(areChangedFilesReviewPropsEqual(props, {
        ...props,
        theme: createThemeFixture({ ...theme, space: { ...theme.space } }),
    })).toBe(true);
    expect(areChangedFilesReviewPropsEqual(props, {
        ...props,
        theme: createThemeFixture({ ...theme, space: resolveThemeStyleScales({ density: 'compact' }).space }),
    })).toBe(false);
});
