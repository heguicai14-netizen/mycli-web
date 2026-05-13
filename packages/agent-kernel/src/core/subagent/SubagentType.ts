export interface SubagentType {
  /** LLM-facing type name. Must match /^[a-z][a-z0-9_-]*$/. */
  readonly name: string
  /** 1–2 sentence summary shown in the Task tool description. */
  readonly description: string
  /** Sub-agent's system prompt. */
  readonly systemPrompt: string
  /** Whitelist of tool names. '*' = all parent tools minus Task. */
  readonly allowedTools: '*' | readonly string[]
  /** Override default maxIterations. */
  readonly maxIterations?: number
  /** Override the model name. Shares the parent's OpenAI client. */
  readonly model?: string
  /** Reserved for future concurrency control. v1 does NOT enforce. */
  readonly maxConcurrent?: number
}

export type SubagentTypeRegistry = ReadonlyMap<string, SubagentType>

const NAME_RE = /^[a-z][a-z0-9_-]*$/

export function buildSubagentTypeRegistry(
  types: readonly SubagentType[],
): SubagentTypeRegistry {
  const map = new Map<string, SubagentType>()
  for (const t of types) {
    if (!NAME_RE.test(t.name)) {
      throw new Error(
        `SubagentType: invalid name "${t.name}" — must match /^[a-z][a-z0-9_-]*$/`,
      )
    }
    if (map.has(t.name)) {
      throw new Error(`SubagentType: duplicate name "${t.name}"`)
    }
    map.set(t.name, t)
  }
  return map
}
