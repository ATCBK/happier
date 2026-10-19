export const mentionMigrationId = '20261019120000_discussion_typed_account_mentions';
const oldParts = [{ t: 'text', text: 'Before '.repeat(300) }, { t: 'mention', accountId: 'account-a' },
    { t: 'text', text: ' between ' }, { t: 'mention', accountId: 'account-b' },
    { t: 'mention', participant: { kind: 'account', accountId: 'already-typed' } }, { t: 'text', text: ' after' }];
export const migratedMentionParts = oldParts.map(part => 'accountId' in part
    ? { t: 'mention', participant: { kind: 'account', accountId: part.accountId } } : part);
export const mentionMigrationFixtures = [
    { id: 'legacy', content: { t: 'plain', v: { v: 1, parts: oldParts } } },
    { id: 'typed', content: { t: 'plain', v: { v: 1, parts: migratedMentionParts } } },
    { id: 'encrypted', content: { t: 'encrypted', c: JSON.stringify(oldParts), v: { v: 1, parts: oldParts } } },
    { id: 'other-plain', content: { t: 'plain', v: { kind: 'doc_edit_proposal', proposal: { opaque: oldParts } } } },
    { id: 'other-version', content: { t: 'plain', v: { v: 2, parts: oldParts } } },
] as const;
