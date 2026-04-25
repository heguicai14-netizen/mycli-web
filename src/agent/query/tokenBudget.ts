/**
 * Rough token count: ~4 chars per token for English text. Good enough for a budget
 * approximation. Plan D may swap in a real BPE tokenizer if compaction needs precision.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function estimateMessageTokens(msg: { content: unknown }): number {
  if (typeof msg.content === 'string') return estimateTokens(msg.content)
  if (Array.isArray(msg.content)) {
    let n = 0
    for (const part of msg.content) {
      if (typeof part === 'string') n += estimateTokens(part)
      else if (
        part &&
        typeof part === 'object' &&
        'text' in part &&
        typeof (part as { text: unknown }).text === 'string'
      ) {
        n += estimateTokens((part as { text: string }).text)
      }
    }
    return n
  }
  return 0
}
