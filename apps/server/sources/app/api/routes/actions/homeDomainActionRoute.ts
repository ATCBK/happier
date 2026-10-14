import { homeDomainActionTransportV1, type HomeDomainActionIdV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';

type HomeDomainActionHttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/**
 * Resolves an explicit Home-domain route from its canonical Action declaration.
 *
 * Fastify handlers still own authentication, schemas, feature admission, and
 * execution. The method argument asserts that the explicit handler selected the
 * method declared by the Action row instead of becoming a second transport
 * decision.
 */
export function homeDomainActionPathForMethod(
    actionId: HomeDomainActionIdV1,
    method: HomeDomainActionHttpMethod,
): string {
    const transport = homeDomainActionTransportV1(actionId);
    if (transport.method !== method) {
        throw new TypeError(
            `Home-domain Action ${actionId} declares ${transport.method} ${transport.path}, not ${method}.`,
        );
    }
    return transport.path;
}
