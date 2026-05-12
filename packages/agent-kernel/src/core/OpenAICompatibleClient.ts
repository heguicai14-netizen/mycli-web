export interface NormalizedUsage {
  in: number
  out: number
  /** Provider-reported cached prompt tokens. undefined if provider doesn't expose it. */
  cached?: number
}

export type UsageParser = (rawUsage: unknown) => Pick<NormalizedUsage, 'cached'>

/**
 * Default usage parser. Recognizes OpenAI/GLM-4.6 (prompt_tokens_details.cached_tokens)
 * and DeepSeek (prompt_cache_hit_tokens) shapes. Returns { cached: undefined } for
 * unknown shapes — never throws.
 */
export const defaultUsageParser: UsageParser = (raw) => {
  if (!raw || typeof raw !== 'object') return { cached: undefined }
  const u = raw as Record<string, unknown>
  const openaiPath = (u.prompt_tokens_details as { cached_tokens?: unknown } | undefined)
    ?.cached_tokens
  if (typeof openaiPath === 'number') return { cached: openaiPath }
  if (typeof u.prompt_cache_hit_tokens === 'number') {
    return { cached: u.prompt_cache_hit_tokens }
  }
  return { cached: undefined }
}

export interface ClientConfig {
  apiKey: string
  baseUrl: string
  model: string
  /**
   * Hard timeout in ms for the LLM fetch. Default 60_000. Set to 0 to disable
   * (fetch hangs indefinitely on unresponsive endpoints).
   */
  fetchTimeoutMs?: number
  /**
   * Override how cached_tokens is extracted from the raw usage object on the
   * final SSE chunk. Defaults to defaultUsageParser. Errors thrown by this
   * function are caught (warning emitted) and treated as cached=undefined.
   */
  usageParser?: UsageParser
}

function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => !!s)
  if (live.length === 0) return undefined
  if (live.length === 1) return live[0]
  const ctrl = new AbortController()
  for (const s of live) {
    if (s.aborted) {
      ctrl.abort(s.reason)
      return ctrl.signal
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true })
  }
  return ctrl.signal
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  name?: string
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: Array<{
    type: 'function'
    function: { name: string; description: string; parameters: Record<string, unknown> }
  }>
  signal?: AbortSignal
}

export type StreamEvent =
  | { kind: 'delta'; text: string }
  | {
      kind: 'toolDelta'
      index: number
      id?: string
      name?: string
      argumentsDelta?: string
    }
  | {
      kind: 'done'
      stopReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown'
      toolCalls?: Array<{ id: string; name: string; input: unknown }>
      usage?: NormalizedUsage
    }

import { classifyError } from '../errors'

export class OpenAICompatibleClient {
  constructor(private cfg: ClientConfig) {}

  async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
    try {
      yield* this.streamChatInner(req)
    } catch (e) {
      const classified = classifyError(e)
      const wrappedError = Object.assign(new Error(classified.message), {
        code: classified.code,
        retryable: classified.retryable,
        cause: classified.cause,
        // Preserve HTTP status if present so downstream consumers can still inspect it
        ...(typeof (e as any)?.status === 'number' ? { status: (e as any).status } : {}),
      })
      throw wrappedError
    }
  }

  private async *streamChatInner(req: ChatRequest): AsyncIterable<StreamEvent> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      stream: true,
      messages: req.messages,
    }
    if (req.tools && req.tools.length) body.tools = req.tools
    // Always request usage stats. OpenAI-compatible endpoints that don't support
    // stream_options either ignore the key or omit `usage` from the stream — both
    // are handled (callers see `usage` as undefined). This is required by the eval
    // harness's efficiency scoring.
    body.stream_options = { include_usage: true }

    const timeoutMs = this.cfg.fetchTimeoutMs ?? 60_000
    const timeoutController = timeoutMs > 0 ? new AbortController() : undefined
    const timeoutId =
      timeoutMs > 0 && timeoutController
        ? setTimeout(
            () => timeoutController.abort(new Error('llm fetch timeout')),
            timeoutMs,
          )
        : undefined

    // Combine consumer signal with our timeout controller
    const combinedSignal = combineSignals(req.signal, timeoutController?.signal)

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    }).catch((e) => {
      if (timeoutController?.signal.aborted) {
        throw new Error(`LLM fetch timeout after ${timeoutMs}ms`)
      }
      throw e
    })
    if (timeoutId) clearTimeout(timeoutId)

    if (!res.ok) {
      let detail: unknown = undefined
      try {
        detail = await res.json()
      } catch {
        try {
          detail = await res.text()
        } catch {
          /* ignore */
        }
      }
      throw Object.assign(new Error(`LLM HTTP ${res.status}`), { status: res.status, detail })
    }
    if (!res.body) throw new Error('no response body')

    // Accumulator for tool_calls (OpenAI streams them in pieces by index)
    const toolAcc = new Map<number, { id: string; name: string; arguments: string }>()
    let finishReason: string | undefined
    let usage: NormalizedUsage | undefined

    const reader = res.body.getReader()
    // Abort signal → cancel the reader. Real fetch honors AbortSignal natively, but
    // we wire it explicitly so callers (and tests with mocked fetch) get prompt
    // cancellation regardless of how the underlying transport plumbs the signal.
    if (req.signal) {
      const onAbort = () => {
        reader.cancel().catch(() => {})
      }
      if (req.signal.aborted) onAbort()
      else req.signal.addEventListener('abort', onAbort, { once: true })
    }
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const line = event.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          finishReason = finishReason ?? 'stop'
          continue
        }
        let parsed: any
        try {
          parsed = JSON.parse(payload)
        } catch {
          continue
        }
        if (parsed.usage && typeof parsed.usage.prompt_tokens === 'number') {
          const parser = this.cfg.usageParser ?? defaultUsageParser
          let cachedField: number | undefined
          try {
            cachedField = parser(parsed.usage).cached
          } catch (e) {
            console.warn('[OpenAICompatibleClient] usageParser threw, treating cached as undefined', e)
            cachedField = undefined
          }
          usage = {
            in: parsed.usage.prompt_tokens,
            out: parsed.usage.completion_tokens ?? 0,
            ...(cachedField !== undefined ? { cached: cachedField } : {}),
          }
        }
        const choice = parsed?.choices?.[0]
        if (!choice) continue

        if (choice.delta?.content) {
          yield { kind: 'delta', text: choice.delta.content }
        }
        if (Array.isArray(choice.delta?.tool_calls)) {
          for (const tc of choice.delta.tool_calls) {
            const i = tc.index ?? 0
            const existing = toolAcc.get(i) ?? { id: '', name: '', arguments: '' }
            if (tc.id) existing.id = tc.id
            if (tc.function?.name) existing.name = tc.function.name
            if (typeof tc.function?.arguments === 'string') {
              existing.arguments += tc.function.arguments
            }
            toolAcc.set(i, existing)
            yield {
              kind: 'toolDelta',
              index: i,
              id: tc.id,
              name: tc.function?.name,
              argumentsDelta: tc.function?.arguments,
            }
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason
      }
    }

    const known: Record<string, true> = {
      stop: true,
      tool_calls: true,
      length: true,
      content_filter: true,
    }
    const sr = finishReason ?? 'stop'
    const reason = (known[sr] ? sr : 'unknown') as
      | 'stop'
      | 'tool_calls'
      | 'length'
      | 'content_filter'
      | 'unknown'

    const tcs = Array.from(toolAcc.values()).map((t) => {
      let input: unknown = {}
      try {
        input = t.arguments ? JSON.parse(t.arguments) : {}
      } catch {
        input = { _rawArguments: t.arguments }
      }
      return { id: t.id || crypto.randomUUID(), name: t.name, input }
    })
    yield { kind: 'done', stopReason: reason, toolCalls: tcs.length ? tcs : undefined, usage }
  }
}
