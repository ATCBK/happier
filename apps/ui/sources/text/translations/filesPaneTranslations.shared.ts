

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
    /** The tree's All | Changed view switch (lab FB1) and its accessible name. */
    showAll: string;
    showChanged: string;
    showLabel: string;
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
    page: Readonly<{
        view: string;
        preview: string;
        source: string;
        changes: string;
        unsaved: string;
        folders: string;
        discardEdits: string;
        updatedJustNow: string;
        downloadWholeFile: string;
        artifactTitle: string;
        artifactDescription: string;
        artifactTitleLabel: string;
        artifactAudience: string;
        artifactOnlyYou: string;
        artifactSave: string;
        artifactSaved: string;
        artifactOpen: string;
        artifactFailed: string;
        artifactApproval: string;
        updatedByJustNow: (params: Readonly<{ agent: string }>) => string;
        updatedByForJustNow: (params: Readonly<{ agent: string; person: string }>) => string;
        byAgentAge: (params: Readonly<{ agent: string; age: string }>) => string;
        byAgentForAge: (params: Readonly<{ agent: string; person: string; age: string }>) => string;
        deletedBy: (params: Readonly<{ agent: string }>) => string;
        deletedByAt: (params: Readonly<{ agent: string; time: string }>) => string;
        deletedAt: (params: Readonly<{ time: string }>) => string;
        readingFrom: (params: Readonly<{ machine: string; seconds: number }>) => string;
        tooLargeTitle: (params: Readonly<{ size: string }>) => string;
        tooLargeBody: (params: Readonly<{ slice: string }>) => string;
        showFirst: (params: Readonly<{ slice: string }>) => string;
        showLast: (params: Readonly<{ slice: string }>) => string;
        showingFirst: (params: Readonly<{ slice: string; size: string }>) => string;
        showingLast: (params: Readonly<{ slice: string; size: string }>) => string;
        partialFact: (params: Readonly<{ slice: string; size: string }>) => string;
        fromMachine: (params: Readonly<{ machine: string }>) => string;
    }>;
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
        showAll: 'All',
        showChanged: 'Changed',
        showLabel: 'Show',
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
        page: {
            view: "View",
            preview: "Preview",
            source: "Source",
            changes: "Changes",
            unsaved: "Unsaved",
            folders: "Folders",
            discardEdits: "Discard edits",
            updatedJustNow: "Updated just now",
            downloadWholeFile: "Download the whole file",
            artifactTitle: "Save as Artifact",
            artifactDescription: "An Artifact is a copy you can share. Later changes to the file don’t change it.",
            artifactTitleLabel: "Title",
            artifactAudience: "Who can see it",
            artifactOnlyYou: "Only you",
            artifactSave: "Save as Artifact",
            artifactSaved: "Saved as Artifact",
            artifactOpen: "Open",
            artifactFailed: "Couldn’t save the Artifact. Try again.",
            artifactApproval: "Waiting for approval",
            updatedByJustNow: ({ agent }) => "Updated by " + agent + " just now",
            updatedByForJustNow: ({ agent, person }) => "Updated by " + agent + " for " + person + " just now",
            byAgentAge: ({ agent, age }) => "by " + agent + " " + age,
            byAgentForAge: ({ agent, person, age }) => "by " + agent + " for " + person + " " + age,
            deletedBy: ({ agent }) => "Deleted by " + agent,
            deletedByAt: ({ agent, time }) => "Deleted by " + agent + " at " + time,
            deletedAt: ({ time }) => "Deleted at " + time,
            readingFrom: ({ machine, seconds }) => "Reading it from " + machine + " · " + seconds + " s",
            tooLargeTitle: ({ size }) => "This file is " + size,
            tooLargeBody: ({ slice }) => "Previews show the first " + slice + ".",
            showFirst: ({ slice }) => "Show first " + slice,
            showLast: ({ slice }) => "Show the last " + slice,
            showingFirst: ({ slice, size }) => "Showing the first " + slice + " of " + size,
            showingLast: ({ slice, size }) => "Showing the last " + slice + " of " + size,
            partialFact: ({ slice, size }) => slice + " of " + size,
            fromMachine: ({ machine }) => "from " + machine,
        },
    } } as const satisfies Pick<Record<string, FilesPaneTranslations>, "en">;
