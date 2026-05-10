import type { OpenAICompatibleClient, ChatMessage } from './OpenAICompatibleClient'

export interface CompactInput {
  /** Messages to summarize (oldest first). Caller has already excluded the
   *  recent tail it wants to keep verbatim. */
  messages: ChatMessage[]
  client: OpenAICompatibleClient
  signal?: AbortSignal
}

const SYSTEM = `You are summarizing an earlier portion of a conversation between a user and an AI assistant. The summary will replace these turns in the assistant's context window so it can keep helping the user without exceeding token limits.

Preserve, in this order of priority:
1. The user's high-level goals and current task.
2. Concrete facts discovered (URLs, IDs, names, numbers, file paths, decisions).
3. Outstanding questions or next steps.
4. Errors encountered and how they were resolved (or that they remain unresolved).

Drop:
- Pleasantries and meta-discussion.
- Verbatim tool output (keep only the conclusion drawn from it).
- Repetition.

Format as a tight bulleted list under headings: "Goals", "Facts", "Open items". Keep the whole summary under 400 tokens. Write in the same language as the conversation.`

function transcript(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const role = m.role
      const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
      return `[${role}]\n${body}`
    })
    .join('\n\n')
}

/**
 * Run a one-shot non-streaming-style summarize via streamChat (we accumulate
 * deltas into a string). Uses the same OpenAICompatibleClient instance so the
 * caller's API key, baseUrl, and model are reused.
 *
 * Throws on any client error; callers are expected to catch and degrade
 * gracefully (skip compaction this turn, continue with full history).
 */
export async function compactMessages(input: CompactInput): Promise<string> {
  if (input.messages.length === 0) return ''

  let summary = ''
  for await (const ev of input.client.streamChat({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `=== Earlier conversation ===\n\n${transcript(input.messages)}` },
    ],
    signal: input.signal,
  })) {
    if (ev.kind === 'delta') summary += ev.text
  }
  return summary.trim()
}
