export interface ClientConfig {
  apiKey: string
  baseUrl: string
  model: string
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
    }

export class OpenAICompatibleClient {
  constructor(private cfg: ClientConfig) {}

  async *streamChat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      stream: true,
      messages: req.messages,
    }
    if (req.tools && req.tools.length) body.tools = req.tools

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    })

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
    yield { kind: 'done', stopReason: reason, toolCalls: tcs.length ? tcs : undefined }
  }
}
