import { describe, expect, it } from 'vitest';
import { AutomationTriggerDefinitionInputSchema } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';

import { WEEKLY_STORAGE_REVIEW_PROMPT, createWeeklyStorageReviewWorkflowSeed } from './weeklyStorageReviewTemplate';
import { readDeviceTimeZone } from '@/components/workflows/triggers/sessionTriggerForm';

describe('weekly storage review Automation template', () => {
    it('seeds one ordinary Monday-morning scheduled workflow that asks for reviewable proposals, not deletion', () => {
        const seed = createWeeklyStorageReviewWorkflowSeed({ name: 'Weekly storage review' });
        expect(WorkflowDefinitionV1Schema.safeParse(seed.definition).success).toBe(true);
        expect(AutomationTriggerDefinitionInputSchema.safeParse(seed.trigger).success).toBe(true);
        expect(seed.trigger).toMatchObject({ kind: 'schedule', enabled: true,
            schedule: { kind: 'cron', scheduleExpr: '0 9 * * 1', timezone: readDeviceTimeZone() } });
        expect(seed.definition.blocks).toHaveLength(1);
        expect(seed.definition.blocks[0]).toMatchObject({ kind: 'step', document: { text: WEEKLY_STORAGE_REVIEW_PROMPT } });
        // The ordinary editor resolves the person's Agent for the selected Machine;
        // an authored role here would override that persisted choice for unattended runs.
        expect(seed.definition.blocks[0]).not.toHaveProperty('execution.engine');
        expect(seed.definition.defaults).toEqual({});
        expect(WEEKLY_STORAGE_REVIEW_PROMPT).toMatch(/each machine/u);
        expect(WEEKLY_STORAGE_REVIEW_PROMPT).toMatch(/since the last scan/u);
        expect(WEEKLY_STORAGE_REVIEW_PROMPT).toMatch(/Move items to Trash/u);
        expect(WEEKLY_STORAGE_REVIEW_PROMPT).toMatch(/machines\.storage\.trash\.move/u);
        expect(WEEKLY_STORAGE_REVIEW_PROMPT).toMatch(/Nothing worth cleaning/u);
    });
});
