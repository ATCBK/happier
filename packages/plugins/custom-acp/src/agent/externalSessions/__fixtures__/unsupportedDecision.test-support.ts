/** X6 native-history decision: ACP setup alone supplies no read-only body store. */
export const CUSTOM_ACP_EXTERNAL_SESSIONS_DECISION = Object.freeze({
  status: 'unsupported' as const,
  reason: 'definition_specific_history' as const,
  message: 'Conversation history is definition-specific for custom ACP Agents. No validated native history reader is configured for this definition. ACP list/resume support alone does not provide standard content search or external-conversation indexing.',
  requiredEvidence: 'A named definition, pinned executable version, native session identity and non-mutating native history contract.',
  contentSearch: false,
  externalIndexing: false,
});
