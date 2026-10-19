

export type DetailPageTranslations = Readonly<{
    approval: Readonly<{
        requestTitle: string;
        requestDescription: string;
        failureTitle: string;
        homeUnavailableTitle: string;
        contextTitle: string;
        contextDescription: string;
        sessionOnHome: (params: Readonly<{ home: string }>) => string;
        sessionElsewhere: string;
        origin: Readonly<Record<'voice' | 'agent' | 'mcp' | 'cli' | 'ui' | 'api' | 'plugin' | 'system', string>>;
        proposalsDescription: string;
        requester: Readonly<{
            title: string;
            descriptionYou: string;
            descriptionOther: (params: Readonly<{ name: string }>) => string;
            askedBy: string;
            writesWith: string;
            setupOf: (params: Readonly<{ name: string }>) => string;
            anotherPerson: string;
            waitingFor: (params: Readonly<{ name: string }>) => string;
            confirmedBy: string;
            declinedBy: string;
            thread: Readonly<{
                youConfirm: string;
                review: string;
                decline: string;
                waiting: (params: Readonly<{ name: string }>) => string;
                writesWith: (params: Readonly<{ name: string }>) => string;
                writesWithYours: string;
                confirmedPending: (params: Readonly<{ name: string }>) => string;
                done: (params: Readonly<{ name: string }>) => string;
                declined: (params: Readonly<{ name: string }>) => string;
                canceled: string;
                uncertain: string;
                failed: string;
            }>;
        }>;
    }>;
    runs: Readonly<{
        description: string;
        filterLabel: string;
        filterRunning: string;
        filterAll: string;
        onHome: (params: Readonly<{ home: string }>) => string;
    }>;
    person: Readonly<{
        placeholderTitle: string;
        friendshipTitle: string;
        sharedSessionsDescription: string;
        linkedAccountsTitle: string;
        linkedAccountsDescription: string;
    }>;
    friendsManage: Readonly<{
        description: string;
        requestsTitle: string;
        requestsDescription: string;
        sentTitle: string;
        sentDescription: string;
        friendsTitle: string;
        friendsDescription: string;
    }>;
}>;


export const detailPageTranslationsEnglish = { en: {
        approval: {
            requestTitle: 'Request',
            requestDescription: 'What was asked and where it stands.',
            failureTitle: 'Why it failed',
            homeUnavailableTitle: 'Home unavailable',
            contextTitle: 'Requested by',
            contextDescription: 'The session and agent that asked for this.',
            sessionOnHome: ({ home }) => `A session on ${home}`,
            sessionElsewhere: 'A session that isn’t on this device',
            origin: {
                voice: 'Asked by voice',
                agent: 'Asked by an agent',
                mcp: 'Asked through a connected tool',
                cli: 'Asked from the command line',
                ui: 'Asked in the app',
                api: 'Asked through the API',
                plugin: 'Asked by a plugin',
                system: 'Asked by Happier',
            },
            proposalsDescription: 'Posted to the review if you approve.',
            requester: {
                title: 'Who confirms',
                descriptionYou: 'You asked for this, so you confirm it.',
                descriptionOther: ({ name }) => `${name} asked for this, so only they can confirm it.`,
                askedBy: 'Asked by',
                writesWith: 'Writes with',
                setupOf: ({ name }) => `${name}’s setup`,
                anotherPerson: 'Another person',
                waitingFor: ({ name }) => `Waiting for ${name} to confirm`,
                confirmedBy: 'Confirmed by',
                declinedBy: 'Declined by',
                thread: {
                    youConfirm: 'You asked, so you confirm',
                    review: 'Review and confirm…',
                    decline: 'Decline',
                    waiting: ({ name }) => `Waiting for ${name} to confirm. Only the person who asked can.`,
                    writesWith: ({ name }) => `Writes with ${name}’s setup`,
                    writesWithYours: 'Writes with your setup',
                    confirmedPending: ({ name }) => `Confirmed by ${name} · waiting for the result`,
                    done: ({ name }) => `Done · confirmed by ${name}`,
                    declined: ({ name }) => `Declined by ${name} · nothing was written`,
                    canceled: 'Canceled · nothing was written',
                    uncertain: 'Not known yet whether this went through. Don’t confirm again.',
                    failed: 'Didn’t go through',
                },
            },
        },
        runs: {
            description: 'Background runs on your machines.',
            filterLabel: 'Runs to show',
            filterRunning: 'Running',
            filterAll: 'All',
            onHome: ({ home }) => `On ${home}`,
        },
        person: {
            placeholderTitle: 'Person',
            friendshipTitle: 'Friendship',
            sharedSessionsDescription: 'Sessions this friend shares with you, view only.',
            linkedAccountsTitle: 'Linked accounts',
            linkedAccountsDescription: 'Where else they sign in. Opens in your browser.',
        },
        friendsManage: {
            description: 'People you work with on Happier, and requests between you.',
            requestsTitle: 'Friend requests',
            requestsDescription: 'Open a request to accept or decline it.',
            sentTitle: 'Sent requests',
            sentDescription: 'Waiting for them to accept.',
            friendsTitle: 'Friends',
            friendsDescription: 'Open a friend to see what they share with you.',
        },
    } } as const satisfies Pick<Record<string, DetailPageTranslations>, "en">;