

export type FilesPaneTranslations = Readonly<{
    menu: Readonly<{
        openBeside: string;
        openWithBlame: string;
        wrap: string;
        background: string;
        raw: string;
        copyContents: string;
        revealInFiles: string;
        showBlame: string;
        hideBlame: string;
        copyPath: string;
        copyHappierLink: string;
        attachToMessage: string;
        saveAsArtifact: string;
        openInDefaultApp: string;
        restoreBeforeTurn: (params: Readonly<{ turn: number }>) => string;
        restoreBeforeTurnFallback: string;
        discardAllChanges: string;
        goToDefinition: string;
        showInfo: string;
        restartLanguageServices: string;
    }>;
    changedOnly: string;
    showAllFiles: string;
    viewOptions: string;
    sizeAndDate: string;
    newMenu: string;
    newFile: string;
    newFolder: string;
    noChangedFilesTitle: string;
    noChangedFilesReason: string;
    rootErrorTitle: (params: Readonly<{ machine: string }>) => string;
    rootErrorTitleUnnamed: string;
    workspaceUnavailableReason: string;
}>;


export const filesPaneTranslationsEnglish = { en: {
        menu: {
            openBeside: "Open beside",
            openWithBlame: "Open with blame",
            wrap: "Wrap lines",
            background: "Background",
            raw: "Source",
            copyContents: "Copy contents",
            revealInFiles: "Reveal in Files",
            showBlame: "Show blame",
            hideBlame: "Hide blame",
            copyPath: "Copy path",
            copyHappierLink: "Copy Happier link",
            attachToMessage: "Attach to message",
            saveAsArtifact: "Save as Artifact…",
            openInDefaultApp: "Open in default app",
            restoreBeforeTurn: ({ turn }) => "Restore this file to before turn" + " " + turn,
            restoreBeforeTurnFallback: 'Restore file',
            discardAllChanges: "Discard all changes in this file",
            goToDefinition: "Go to definition at cursor",
            showInfo: "Info at cursor",
            restartLanguageServices: "Restart language services",
        },
        changedOnly: 'Changed only',
        showAllFiles: 'Show all files',
        viewOptions: 'View options',
        sizeAndDate: 'Size and date',
        newMenu: 'New file, new folder or upload',
        newFile: 'New file',
        newFolder: 'New folder',
        noChangedFilesTitle: 'Nothing has changed',
        noChangedFilesReason: 'The working copy matches the last commit.',
        rootErrorTitle: ({ machine }) => `Couldn’t list files on ${machine}`,
        rootErrorTitleUnnamed: 'Couldn’t list files',
        workspaceUnavailableReason: 'Happier could not resolve a machine and folder for this session.',
    } } as const satisfies Pick<Record<string, FilesPaneTranslations>, "en">;
