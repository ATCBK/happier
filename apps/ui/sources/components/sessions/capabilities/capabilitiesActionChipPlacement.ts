import { t } from '@/text';
import type { AgentInputControlPlacement } from '@/components/sessions/agentInput/controls/agentInputControlTypes';

export const SESSION_CAPABILITIES_CHIP_KEY = 'session-capabilities';
export const SESSION_CAPABILITIES_CHIP_GLYPH = 'stack';

export function getCapabilitiesActionChipPlacement(params: Readonly<{ scoped?: boolean }> = {}): AgentInputControlPlacement {
    return { id: params.scoped ? `capabilities:${SESSION_CAPABILITIES_CHIP_KEY}` : 'capabilities', title: t('settingsAgents.capabilities'), icon: SESSION_CAPABILITIES_CHIP_GLYPH, defaultPlacement: 'overflow' };
}
