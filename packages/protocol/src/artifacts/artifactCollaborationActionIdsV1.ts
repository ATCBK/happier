export const DOC_COLLABORATION_ACTION_IDS_V1 = [
  'doc.read', 'doc.comment.reply', 'doc.edit.propose', 'doc.edit.accept', 'doc.edit.decline',
] as const;
export type DocCollaborationActionIdV1 = typeof DOC_COLLABORATION_ACTION_IDS_V1[number];
