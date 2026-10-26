/** The engine picker row a composer's engine chip stands for. */
export function resolveAgentInputEngineOptionId(input: Readonly<{
    options: ReadonlyArray<Readonly<{ id: string }>>;
    selectedOptionId?: string | null;
    /** The running Agent; its row is `engine:<agentType>` (`AgentInput`'s current-Agent row). */
    agentType?: string | null;
}>): string | null {
    if (typeof input.selectedOptionId === 'string' && input.selectedOptionId.length > 0) return input.selectedOptionId;
    // With nothing chosen, the chip names the running Agent's model, so the popover opens on that
    // Agent — not on whatever row a caller leads the rail with (the Roles rail).
    const runningAgentOptionId = input.agentType ? `engine:${input.agentType}` : null;
    if (runningAgentOptionId && input.options.some((option) => option.id === runningAgentOptionId)) return runningAgentOptionId;
    return input.options[0]?.id ?? null;
}
