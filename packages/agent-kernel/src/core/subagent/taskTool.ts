import { Subagent, SubagentFailedError } from './Subagent'
import type { SubagentTypeRegistry } from './SubagentType'
import { makeOk, makeError } from '../Tool'
import type { ToolDefinition, ToolExecContext, SubagentId } from '../types'
import type { OpenAICompatibleClient } from '../OpenAICompatibleClient'
import { ToolRegistry } from '../ToolRegistry'

interface TaskInput {
  subagent_type: string
  description: string
  prompt: string
}

function buildDescription(registry: SubagentTypeRegistry): string {
  const lines: string[] = []
  lines.push('Spawns a sub-agent to handle a focused sub-task with isolated context.')
  lines.push('')
  lines.push('Available types:')
  for (const t of registry.values()) {
    lines.push(`- ${t.name}: ${t.description}`)
  }
  lines.push('')
  lines.push(
    'Use the Task tool when a sub-task is well-defined and self-contained, ' +
      "especially if you'd otherwise pollute your own context with intermediate steps. " +
      'You cannot nest Task calls.',
  )
  return lines.join('\n')
}

export function buildTaskTool(
  registry: SubagentTypeRegistry,
  llm: OpenAICompatibleClient,
): ToolDefinition<TaskInput, string> {
  const typeNames = Array.from(registry.keys())
  return {
    name: 'Task',
    description: buildDescription(registry),
    inputSchema: {
      type: 'object',
      properties: {
        subagent_type: { type: 'string', enum: typeNames },
        description: { type: 'string', minLength: 1, maxLength: 120 },
        prompt: { type: 'string', minLength: 1 },
      },
      required: ['subagent_type', 'description', 'prompt'],
    },
    async execute(input, ctx) {
      if (!ctx.turnId || !ctx.callId || !ctx.emitSubagentEvent) {
        return makeError(
          'subagent_ctx_missing',
          'Task tool requires ctx.turnId, ctx.callId and ctx.emitSubagentEvent',
          false,
        )
      }
      const type = registry.get(input.subagent_type)
      if (!type) {
        return makeError(
          'unknown_subagent_type',
          `Unknown subagent_type "${input.subagent_type}"`,
          false,
        )
      }

      const parentRegistry: ToolRegistry =
        (ctx as any).__taskParentRegistry ?? new ToolRegistry([])

      const sid = (crypto.randomUUID() as unknown) as SubagentId
      const parentSignal = ctx.signal ?? new AbortController().signal

      const sub = new Subagent({
        id: sid,
        type,
        parentTurnId: ctx.turnId,
        parentCallId: ctx.callId,
        userPrompt: input.prompt,
        userDescription: input.description,
        parentSignal,
        parentCtx: ctx,
        registry: parentRegistry,
        llm,
        emit: ctx.emitSubagentEvent,
      })

      try {
        const result = await sub.run()
        return makeOk(result.text)
      } catch (e) {
        if (e instanceof SubagentFailedError) {
          return makeError(
            'subagent_failed',
            `Subagent ${type.name} failed: ${e.message}. The sub-task was not completed.`,
            false,
          )
        }
        if (parentSignal.aborted) throw e
        return makeError(
          'subagent_failed',
          `Subagent ${type.name} failed: ${(e as Error)?.message ?? String(e)}. The sub-task was not completed.`,
          false,
        )
      }
    },
  }
}
