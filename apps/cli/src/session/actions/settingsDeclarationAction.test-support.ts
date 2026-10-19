import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliSettingsDeclarationAction } from './settingsDeclarationAction';

type AccountParamsWithoutToken<T = Parameters<typeof createAccountServerActionDeps>[0]> =
    T extends unknown ? Omit<T, 'token'> : never;

/** Keep nested settings Actions on the same real Account executor as the CLI. */
export function createCliSettingsDeclarationActionFixture(
    params: Parameters<typeof createCliSettingsDeclarationAction>[0] & AccountParamsWithoutToken,
) {
    const action = createCliSettingsDeclarationAction(params);
    return (request: Omit<Parameters<typeof action>[0], 'executeOwnerAction'>) => action({ ...request,
        executeOwnerAction: ({ actionId, input, context }) => createActionExecutor({
            ...createUnavailableActionTransportDeps(),
            ...(params.credentials ? createAccountServerActionDeps({ ...params, token: params.credentials.token }) : {}),
            settingsDeclarationAction: action,
        }).execute(actionId, input, context),
    });
}
