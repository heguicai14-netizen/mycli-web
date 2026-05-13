import type { SubagentType } from 'agent-kernel'

export const generalPurpose: SubagentType = {
  name: 'general-purpose',
  description:
    'General-purpose agent for multi-step research, page reading, ' +
    'and synthesis tasks. Use when you need to investigate a topic ' +
    'across pages without polluting your own context.',
  systemPrompt: `You are a focused sub-agent dispatched to handle one self-contained sub-task.

Your final reply will be returned to your parent agent as the result of the Task tool. Make it concise, factual, and directly answer what was asked. Do NOT chat — output the answer.

Available tools: readPage, readSelection, querySelector, screenshot, listTabs, fetchGet, todoWrite.

You cannot dispatch further sub-agents.`,
  allowedTools: [
    'readPage',
    'readSelection',
    'querySelector',
    'screenshot',
    'listTabs',
    'fetchGet',
    'todoWrite',
  ],
  maxIterations: 15,
}
