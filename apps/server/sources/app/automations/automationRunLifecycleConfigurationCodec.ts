import { AutomationRunLifecycleTriggerSchema, type AutomationRunLifecycleTrigger } from '@happier-dev/protocol/automations/automationRunLifecycle';
import { AutomationValidationError } from "./automationValidation";

export function decodeAutomationRunLifecycleConfiguration(row: Readonly<{ runLifecycleConfigurationJson?: string | null }>): AutomationRunLifecycleTrigger {
    if (!row.runLifecycleConfigurationJson) throw new AutomationValidationError("source_unavailable");
    return AutomationRunLifecycleTriggerSchema.parse(JSON.parse(row.runLifecycleConfigurationJson));
}
