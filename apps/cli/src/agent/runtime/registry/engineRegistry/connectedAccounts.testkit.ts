import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';

/** No persisted Account binding; purpose admission stays in its real owner. */
export function createUnboundConnectedAccountsFixture() {
    return createConnectedAccountPurposeBindingOwner({
        store: {
            read: async () => ({ v: 1, bindings: [] }),
            update: async () => { throw new Error('Unexpected purpose mutation'); },
            subscribe: () => ({ dispose() {} }),
        },
        selectTarget: async () => { throw new Error('Unexpected Account selection'); },
        resolveTarget: async () => { throw new Error('Unexpected Account projection'); },
        materializeAccount: async () => { throw new Error('Unexpected credential materialization'); },
        projectTargetAccounts: async () => { throw new Error('Unexpected Account listing'); },
        assertTargetAccountMaterializable: async () => { throw new Error('Unexpected listed-account materialization'); },
    });
}
