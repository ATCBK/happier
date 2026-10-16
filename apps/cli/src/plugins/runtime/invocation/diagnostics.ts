import { projectTargetActionApprovalInput } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import type { PluginActionInputParserIssue } from '@happier-dev/protocol/plugins/actions/invocation';

export type TargetActionDiagnosticConfidentiality = Readonly<{
    paths: readonly string[];
    nonStringPaths: readonly string[];
}>;

/** Classification stays with the declaration/SecretString approval owner. */
export function readTargetActionDiagnosticConfidentiality(
    input: unknown,
    secretInputPaths: readonly string[],
    retained?: TargetActionDiagnosticConfidentiality,
): TargetActionDiagnosticConfidentiality {
    const projection = projectTargetActionApprovalInput(input, secretInputPaths);
    if (!projection) throw new Error('Plugin invocation confidential input projection is unavailable');
    const nonStringPaths = projection.confidentialPaths.filter(path => {
        let value: unknown = input;
        for (const segment of path ? path.split('.') : []) {
            if (value === null || typeof value !== 'object') return false;
            value = Reflect.get(value, segment);
        }
        return typeof value !== 'string';
    });
    return {
        paths: [...new Set([...(retained?.paths ?? []), ...projection.confidentialPaths])],
        nonStringPaths: [...new Set([...(retained?.nonStringPaths ?? []), ...nonStringPaths])],
    };
}

export function projectTargetActionDiagnosticIssue(
    value: unknown,
    confidentiality: TargetActionDiagnosticConfidentiality,
): PluginActionInputParserIssue | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const issuePath: unknown = Reflect.get(value, 'path');
    const code: unknown = Reflect.get(value, 'code');
    const message: unknown = Reflect.get(value, 'message');
    if (!Array.isArray(issuePath) || typeof code !== 'string' || typeof message !== 'string') return null;
    let projectedPath: (string | number)[] | undefined;
    let withholdProse = false;
    for (const path of confidentiality.paths) {
        const confidential = path ? path.split('.') : [];
        const sharedLength = Math.min(confidential.length, issuePath.length);
        const location: (string | number)[] = [];
        for (let index = 0; index < sharedLength; index++) {
            const segment: unknown = issuePath[index];
            if ((typeof segment !== 'string' && typeof segment !== 'number') || confidential[index] !== String(segment)) break;
            location.push(segment);
        }
        if (location.length !== sharedLength) continue;
        // Suffixes carry operands regardless of their JSON type. Only the
        // location through the confidential boundary belongs in diagnostics.
        if (!projectedPath || location.length < projectedPath.length) projectedPath = location;
        if (confidentiality.nonStringPaths.includes(path)) withholdProse = true;
    }
    if (!projectedPath) return null;
    return {
        path: projectedPath,
        // Non-string prose has no recoverable provenance; strings still use
        // the invocation's incumbent best-effort text scrubber.
        code: withholdProse ? 'invalid_value' : code,
        message: withholdProse ? 'Confidential input is invalid' : message,
    };
}
