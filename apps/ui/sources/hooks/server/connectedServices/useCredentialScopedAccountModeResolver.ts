import * as React from 'react';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';

export type CredentialScopedAccountMode = 'plain' | 'e2ee';

export function useCredentialScopedAccountModeResolver(params: Readonly<{
    credentials: AuthCredentials | null | undefined;
    credentialScope: string;
}>): () => Promise<CredentialScopedAccountMode> {
    const { credentials, credentialScope } = params;
    const credentialScopeRef = React.useRef(credentialScope);
    credentialScopeRef.current = credentialScope;
    return React.useCallback(async (): Promise<CredentialScopedAccountMode> => {
        if (!credentials) return 'e2ee';
        const requestCredentialScope = credentialScope;
        return await fetchAccountEncryptionMode(credentials, { usage: 'identity' }).then(
            result => credentialScopeRef.current === requestCredentialScope ? result.mode : 'e2ee',
            (): CredentialScopedAccountMode => 'e2ee',
        );
    }, [credentialScope, credentials]);
}
