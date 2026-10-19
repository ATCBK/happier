/**
 * External-author behavior: use only the negotiated public Composer API.
 * Participant identity is supplied by the invoking UI; the host validates
 * the reference, draft transaction and eventual Discussion publication.
 * @param {import('@happier-dev/plugin-sdk/ui').PluginUiHostApi} hostApi
 * @param {Extract<import('@happier-dev/plugin-sdk/ui').ComposerRefV1, {kind:'discussion'}>} composer
 * @param {{text:string, reference:import('@happier-dev/plugin-sdk/ui').ComposerMentionRefV1}} draft
 */
export async function applyDiscussionParticipantReference(hostApi, composer, draft) {
  const read = await hostApi.readComposer(composer);
  if (read.status !== 'ready') return { status: 'composerUnavailable' };
  return hostApi.applyComposer(composer, {
    expectedRevision: read.snapshot.revision,
    operations: [
      { kind: 'text.set', text: draft.text },
      { kind: 'reference.insert', reference: draft.reference },
    ],
  });
}

/**
 * One external-author scenario shared by the real mounted input and server journey.
 * @param {string} sessionId
 * @returns {{draft: {text:string}, reference: import('@happier-dev/plugin-sdk/ui').ComposerMentionRefV1, content: import('@happier-dev/plugin-sdk/actions').PluginActionInputById['discussion.post']['content']}}
 */
export function createDiscussionParticipantQuestion(sessionId) {
  return {
    draft: {
      text: '@Reviewer Check this',
    },
    reference: {
      kind: 'happier.session', ref: `session:${encodeURIComponent(sessionId)}`,
      label: 'Reviewer', token: '@Reviewer', start: 0, end: '@Reviewer'.length,
    },
    content: { v: 1, parts: [
      { t: 'mention', participant: { kind: 'session', sessionId } },
      { t: 'text', text: ' Check this' },
    ] },
  };
}

/**
 * Submit the mounted composer's serialized value through the public Action API.
 * @param {import('@happier-dev/plugin-sdk/ui').PluginUiHostApi} hostApi
 * @param {Extract<import('@happier-dev/plugin-sdk/ui').ComposerRefV1, {kind:'discussion'}>} composer
 * @param {import('@happier-dev/plugin-sdk/actions').PluginActionInputById['discussion.post']} input
 */
export async function postDiscussionComposerContent(hostApi, composer, input) {
  return hostApi.executeAction('discussion.post', { ...input, discussionId: composer.discussionId });
}
