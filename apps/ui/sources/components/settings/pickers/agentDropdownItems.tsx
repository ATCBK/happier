import * as React from 'react';

import type { AgentId } from '@/agents/catalog/catalog';
import { getAgentCore } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';

/** Agents as menu choices: each one's own mark and display name, never its raw id. */
export function getAgentDropdownMenuItems(params: {
    agentIds: readonly AgentId[];
    iconSize?: number;
}): readonly DropdownMenuItem[] {
    const iconSize = params.iconSize ?? 22;
    return params.agentIds.map((id) => {
        // An externally installed Agent contributes no bundled display name; the
        // formatted id keeps it selectable instead of dropping it from the menu.
        const core = getAgentCore(id);
        return {
            id: String(id),
            title: core ? t(core.displayNameKey) : formatAgentLikeIdForDisplay(id),
            icon: <AgentIcon agentId={String(id)} size={iconSize} />,
        };
    });
}
