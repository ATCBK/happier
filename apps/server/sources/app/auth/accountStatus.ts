import { isActiveHomeAccountStatus, type AccountStatusV1 } from '@happier-dev/protocol/home/governance';

/** Internal admission failure. Transports reveal it only after fresh Account proof. */
export class InactiveAccountError extends Error {
    readonly code = "account-disabled";

    constructor() {
        super("account-disabled");
        this.name = "InactiveAccountError";
    }
}

/** Lifecycle admission is independent of key readiness and external identity eligibility. */
export function assertAccountActive(status: AccountStatusV1): void {
    if (!isActiveHomeAccountStatus(status)) throw new InactiveAccountError();
}
