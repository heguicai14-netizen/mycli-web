import type { ToolDefinition } from '../types'
import type { TodoItem, TodoWriteInput } from '../../adapters/TodoStoreAdapter'
import { makeOk, makeError } from '../Tool'

export const todoWriteTool: ToolDefinition<
  { items: TodoWriteInput[] },
  { count: number; items: TodoItem[] },
  Record<string, never>
> = {
  name: 'todoWrite',
  description: `Replace the active conversation's todo list. This tool is
full-list-replace: pass the ENTIRE intended new state — items missing from
your input are deleted, items with id preserve their original createdAt,
items without id become new entries.

Use this when working on a multi-step task (3+ distinct steps). Mark items
in_progress while working on them; never have more than one in_progress at
a time. The list is per-conversation and persists across page reloads.`,
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            subject: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            description: { type: 'string' },
            activeForm: { type: 'string' },
          },
          required: ['subject', 'status'],
        },
      },
    },
    required: ['items'],
  },
  async execute({ items }, ctx) {
    if (!ctx.todoStore) {
      return makeError('todo_unavailable', 'todoStore not configured for this agent')
    }
    if (!ctx.conversationId) {
      return makeError('no_conversation', 'todoWrite requires an active conversation')
    }
    try {
      const result = await ctx.todoStore.replace(ctx.conversationId, items)
      return makeOk({ count: result.length, items: result })
    } catch (e) {
      return makeError(
        'todo_persist_failed',
        e instanceof Error ? e.message : String(e),
        true,
      )
    }
  },
}
