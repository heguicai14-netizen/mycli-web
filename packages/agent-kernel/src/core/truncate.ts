/**
 * Truncate tool result content for LLM consumption.
 *
 * Tool outputs can be huge (a readPage on a real-world page can be 100KB+,
 * a fetch on a JSON API can return MB). Sending the raw content to every
 * subsequent LLM call burns tokens fast and may exceed the model's context
 * window outright.
 *
 * Policy:
 *   - Keep the first `maxChars` characters (most tools put the most useful
 *     info at the top: titles, structure, keys).
 *   - Append a marker telling the LLM that content was elided, including the
 *     original size, so it can ask for a more targeted re-fetch if needed.
 *   - `maxChars <= 0` or undefined → no truncation (safety bypass).
 */
export function truncateForLLM(content: string, maxChars: number | undefined): string {
  if (!maxChars || maxChars <= 0) return content
  if (content.length <= maxChars) return content
  const head = content.slice(0, maxChars)
  return `${head}\n\n[truncated by mycli-web — original was ${content.length} chars, showing first ${maxChars}]`
}
