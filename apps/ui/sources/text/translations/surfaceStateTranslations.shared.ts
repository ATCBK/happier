

export type SurfaceStateTranslations = Readonly<{
    stillWaiting: (params: Readonly<{ seconds: number }>) => string;
    asOf: (params: Readonly<{ time: string }>) => string;
    howItWorks: string;
    tryAgain: string;
    checkAgain: string;
    paneFailedTitle: string;
    paneFailedReason: string;
    opening: (params: Readonly<{ name: string }>) => string;
    couldNotOpen: (params: Readonly<{ name: string }>) => string;
    /** Last-known content stays on screen after a failed re-read. */
    couldNotUpdate: string;
}>;


export const surfaceStateTranslationsEnglish = { en: {
        stillWaiting: ({ seconds }) => `Still waiting · ${seconds} s`,
        asOf: ({ time }) => `As of ${time}`,
        howItWorks: 'How it works',
        tryAgain: 'Try again',
        checkAgain: 'Check again',
        paneFailedTitle: 'Couldn’t show this pane',
        paneFailedReason: 'Something went wrong while drawing it. Your session isn’t affected.',
        opening: ({ name }) => `Opening ${name}`,
        couldNotOpen: ({ name }) => `Couldn’t open ${name}`,
        couldNotUpdate: 'Couldn’t update; showing the last version',
    } } as const satisfies Pick<Record<string, SurfaceStateTranslations>, "en">;