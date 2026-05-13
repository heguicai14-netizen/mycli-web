import type { SubagentType } from '../../src/core/subagent'

export const generalPurpose: SubagentType = {
  name: 'general-purpose',
  description:
    'General-purpose agent for multi-step research, page reading, ' +
    'and synthesis tasks. Use when you need to investigate a topic ' +
    'across pages without polluting your own context.',
  systemPrompt:
    'You are a focused sub-agent dispatched to handle one self-contained sub-task. ' +
    'Your final reply will be returned to your parent agent as the result of the Task tool. ' +
    'Be concise, factual, and answer directly. You cannot dispatch further sub-agents.',
  allowedTools: '*',
  maxIterations: 15,
}

export const explore: SubagentType = {
  name: 'explore',
  description:
    'Fast read-only agent for locating and extracting info from pages. ' +
    'Use when you only need to read, not act.',
  systemPrompt:
    'You are a focused read-only sub-agent. Output the answer concisely. ' +
    'You cannot dispatch further sub-agents.',
  allowedTools: ['readPage', 'readSelection', 'querySelector', 'fetchGet'],
  maxIterations: 6,
}

export const evalSubagentTypes: readonly SubagentType[] = [generalPurpose, explore]
