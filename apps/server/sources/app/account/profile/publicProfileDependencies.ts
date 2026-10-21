import { readPublicProfileContextInTx, resolvePublicProfilePrerequisite } from './publicProfileContext';
import type { PublicProfileServerDependencies } from './publicProfileStorage';

/** Production binds the same request-effective config and feature owners as other Account routes. */
export const publicProfileServerDependencies: PublicProfileServerDependencies = {
    readPublicationContext: readPublicProfileContextInTx,
    resolvePrerequisite: resolvePublicProfilePrerequisite,
};
