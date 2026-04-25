import type { ToolDefinition, ToolResult } from '@shared/types'

export type { ToolDefinition, ToolResult } from '@shared/types'

/** Convert a ToolDefinition to OpenAI tools[] entry */
export function toOpenAiTool(def: ToolDefinition): {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
} {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.inputSchema,
    },
  }
}

export function makeError(
  code: string,
  message: string,
  retryable = false,
): { ok: false; error: { code: string; message: string; retryable: boolean } } {
  return { ok: false, error: { code, message, retryable } }
}

export function makeOk<T>(data: T): { ok: true; data: T } {
  return { ok: true, data }
}
