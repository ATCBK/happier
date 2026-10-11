export type ProjectAuthoringOpenFailureDescription = Readonly<{
    titleKey: `projects.authoring.${'stale' | 'offline' | 'refused' | 'unavailable' | 'pending' | 'invalid' | 'empty' | 'error'}`;
    recovery: 'reopen' | 'choose_target' | 'open_client' | 'await_approval' | 'edit_request';
}>;

/** Presentation data only; the authoring Action remains the admission/recovery owner. */
export function describeProjectAuthoringOpenFailure(reason: string | null | undefined): ProjectAuthoringOpenFailureDescription {
    switch (reason) {
        case 'stale': return { titleKey: 'projects.authoring.stale', recovery: 'reopen' };
        case 'offline': return { titleKey: 'projects.authoring.offline', recovery: 'choose_target' };
        case 'refused': return { titleKey: 'projects.authoring.refused', recovery: 'choose_target' };
        case 'unavailable': return { titleKey: 'projects.authoring.unavailable', recovery: 'open_client' };
        case 'pending': return { titleKey: 'projects.authoring.pending', recovery: 'await_approval' };
        case 'invalid': return { titleKey: 'projects.authoring.invalid', recovery: 'edit_request' };
        case 'empty': return { titleKey: 'projects.authoring.empty', recovery: 'choose_target' };
        default: return { titleKey: 'projects.authoring.error', recovery: 'reopen' };
    }
}
