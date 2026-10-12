import type { Message } from '@happier-dev/session-core/messages';

/**
 * A realistic review conversation for the chat-Find reveal browser regression. Its shape is
 * what the five reveal cases need: a first-row match, matches spread through a transcript far
 * taller than the viewport, a short tool card and a tool card taller than the viewport whose
 * match sits deep inside it, and (optionally) older history only Search older reaches.
 */
const filler = [
    'The list keeps its scroll position while rows measure, so the fix has to live in the row owner.',
    'I traced the render path: the dialog subtree is keyed by the draft id, which changes on every edit.',
    'Moving the key to the session id keeps the subtree stable across keystrokes and preserves focus.',
    'The composer still re-renders, but only the field itself, not the overlay above it.',
    'Next I checked the popover anchor: it reads layout once on open and is unaffected by the change.',
];

function diffOutput(lines: number, needleAt: number, needle: string) {
    const out: string[] = [];
    for (let index = 0; index < lines; index += 1) {
        out.push(index === needleAt ? `+    // ${needle}: the draft key is stable now` : `     const line${index} = useDraftField(sessionId, ${index});`);
    }
    return out.join('\n');
}

/** Persisted messages carry their server identity; navigation resolves routes by it. */
const persistedId = (id: string) => `devfindreveal${id.replace(/[^a-z0-9]/gi, '')}`;

function bash(id: string, seq: number, command: string, stdout: string): Message {
    return { kind: 'tool-call', id, realID: persistedId(id), localId: null, seq, createdAt: seq * 1000, children: [], tool: {
        id: `tool-${id}`, name: 'Bash', state: 'completed', createdAt: seq * 1000, startedAt: seq * 1000, completedAt: seq * 1000 + 400,
        description: null, input: { command }, result: { stdout, stderr: '' },
    } } as Message;
}

const user = (id: string, seq: number, text: string): Message => ({ kind: 'user-text', id, realID: persistedId(id), localId: null, seq, createdAt: seq * 1000, text });
const agent = (id: string, seq: number, text: string): Message => ({ kind: 'agent-text', id, realID: persistedId(id), localId: null, seq, createdAt: seq * 1000, text });

/** Messages older than the loaded page: only Search older reaches the match in them. */
export const TRANSCRIPT_FIND_REVEAL_OLDER: readonly Message[] = [
    user('older-1', 1, 'Before we start: the archived needle from last week was the stale draft cache.'),
    agent('older-2', 2, 'Noted. I will keep that cache out of this change.'),
];

export function createTranscriptFindRevealMessages(firstSeq: number): readonly Message[] {
    const messages: Message[] = [];
    let seq = firstSeq;
    messages.push(user(`m${seq}`, seq++, 'Why does the settings modal remount on every keystroke in the draft field?'));
    for (let round = 0; round < 14; round += 1) {
        messages.push(agent(`m${seq}`, seq++, `${filler[round % filler.length]} ${round % 2 === 0 ? 'That explains the remount you saw.' : ''}`));
        messages.push(user(`m${seq}`, seq++, filler[(round + 2) % filler.length]!));
        messages.push(agent(`m${seq}`, seq++, `${filler[(round + 3) % filler.length]} The overlay no longer remounts here.`));
    }
    messages.push(bash(`m${seq}`, seq++, 'rg -n "must not remount the modal" src', 'src/settings/SettingsModal.tsx:41: // must not remount the modal'));
    for (let round = 0; round < 14; round += 1) {
        messages.push(agent(`m${seq}`, seq++, `${filler[(round + 1) % filler.length]} A second remount path is the theme provider.`));
        messages.push(user(`m${seq}`, seq++, filler[(round + 4) % filler.length]!));
    }
    messages.push(agent(`m${seq}`, seq++, 'Here is the full diff of the draft field change.'));
    messages.push(bash(`m${seq}`, seq++, 'git diff --no-color', diffOutput(70, 22, 'must not remount the modal')));
    messages.push(agent(`m${seq}`, seq++, 'That is the whole change. The modal keeps its state while you type.'));
    return messages;
}
