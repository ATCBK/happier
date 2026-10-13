import type { ImportedMcpInputResolutionV1 } from './mcpImportActionInputs';

export type ImportedMcpInputResolutionIssueCode =
    | 'missingSecretName'
    | 'missingSecretValue'
    | 'missingMachineEnvName';

export function getImportedMcpInputResolutionIssues(mapping: ImportedMcpInputResolutionV1 | undefined): ImportedMcpInputResolutionIssueCode[] {
    if (!mapping) return ['missingMachineEnvName'];

    if (mapping.mode === 'savedSecret') {
        const issues: ImportedMcpInputResolutionIssueCode[] = [];
        if (!mapping.secretName.trim()) {
            issues.push('missingSecretName');
        }
        if (mapping.secretValue.length === 0) {
            issues.push('missingSecretValue');
        }
        return issues;
    }

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(mapping.envVarName.trim())) {
        return ['missingMachineEnvName'];
    }

    return [];
}

export function hasImportedMcpInputResolutionIssues(mapping: ImportedMcpInputResolutionV1 | undefined): boolean {
    return getImportedMcpInputResolutionIssues(mapping).length > 0;
}
