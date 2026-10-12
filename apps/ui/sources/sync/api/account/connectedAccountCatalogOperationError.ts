/** A connected-account catalog read or write that could not complete; `code` is the machine reason. */
export class ConnectedAccountCatalogOperationError extends Error {
    constructor(readonly code: string, readonly cause?: unknown) { super(code); this.name = 'ConnectedAccountCatalogOperationError'; }
}
