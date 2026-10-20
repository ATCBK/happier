

export const en = {
    pageDescription: 'What needs you, what changed and who mentioned you.',
    needsYouSummary: ({ approvals, decisions, blocked }: { approvals: number; decisions: number; blocked: number }) => {
        const parts = [
            approvals > 0 ? `${approvals} ${approvals === 1 ? 'approval' : 'approvals'}` : null,
            decisions > 0 ? `${decisions} ${decisions === 1 ? 'decision' : 'decisions'}` : null,
            blocked > 0 ? `${blocked} ${blocked === 1 ? 'blocked session' : 'blocked sessions'}` : null,
        ].filter((part): part is string => part !== null);
        const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? '';
        return `${list} ${approvals + decisions + blocked === 1 ? 'needs you' : 'need you'}.`;
    },
    quickDecision: { deny: 'Deny', allowOnce: 'Allow once' },
    keyHints: { move: 'move', fullPage: 'full page', close: 'close', answering: 'Answering opens the next one' },
    tabs: {
        a11y: 'Inbox view',
        needsYou: 'Needs you',
        updates: 'Updates',
        mentions: 'Mentions',
    },
    groups: {
        openSession: 'Open session',
        openRun: 'Open run',
    },
    rows: {
        step: 'Step',
        workflowRun: 'Workflow run',
        review: 'Review',
        stalled: 'Stalled',
        stalledReason: 'Its machine went offline mid-turn',
        landing: 'Landing',
        settle: 'Settle',
        snoozedUntil: ({ time }: { time: string }) => `Snoozed until ${time}`,
        more: 'More actions',
        approvalNeeded: 'Needs your approval',
        approvalUntitled: 'Approve an action',
        mentionedYou: "Mentioned you",
        newMessage: "New message",
    },
    popover: {
        updates: ({ count }: { count: number }) => (count === 1 ? '1 update' : `${count} updates`),
    },
    types: { approval: "Approvals", decision: "Decisions", blocked: "Blocked" },
    days: { today: "Today", earlier: "Earlier" },
    mentionsEmpty: {
        title: "No mentions",
        description: "When someone mentions you in a Discussion, it lands here.",
    },
    empty: {
        title: 'Nothing needs you',
        description: 'Permission requests, reviews and anything an orchestrator or workflow waits on land here.',
    },
    updatesEmpty: {
        title: 'No updates',
        description: 'Finished sessions and friend requests land here.',
    },
    stale: {
        reason: "Couldn't refresh workflow runs",
        retry: 'Try again',
    },
    settleFailed: "Couldn't settle this session",
    detail: {
        openApproval: 'Open request',
    },
};


export const inboxWorkTranslationsEnglish = { en };