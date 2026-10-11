


export class ExternalSessionPersistedTakeoverPreflightError extends Error {
  readonly actionCode:
    | 'source_unavailable'
    | 'not_allowed'
    | 'reconciliation_required';

  constructor(
    actionCode:
      | 'source_unavailable'
      | 'not_allowed'
      | 'reconciliation_required',
    message: string,
  ) {
    super(message);
    this.name = 'ExternalSessionPersistedTakeoverPreflightError';
    this.actionCode = actionCode;
  }
}
