import { makeOk, makeError } from '@/agent/Tool'
import type { ToolDefinition } from '@shared/types'

interface Input {
  url: string
  headers?: Record<string, string>
}
interface Output {
  status: number
  contentType: string
  body: string
  truncated: boolean
}

const MAX_BODY_BYTES = 200 * 1024 // 200 KB cap

export const fetchGetTool: ToolDefinition<Input, Output> = {
  name: 'fetchGet',
  description:
    'Fetch a URL with HTTP GET and return the response body as text (truncated at 200KB). For non-GET, use a future fetchWrite tool that requires approval.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute URL to fetch' },
      headers: {
        type: 'object',
        description: 'Optional request headers (no Authorization unless user opts in)',
      },
    },
    required: ['url'],
  },
  exec: 'offscreen',
  async execute(input) {
    try {
      const res = await fetch(input.url, {
        method: 'GET',
        headers: input.headers ?? {},
        // No credentials by default — extension fetch from offscreen has host_permissions,
        // but we don't want to leak the user's cookies to arbitrary URLs the agent picks.
        credentials: 'omit',
      })
      const buf = new Uint8Array(await res.arrayBuffer())
      const truncated = buf.byteLength > MAX_BODY_BYTES
      const sliced = truncated ? buf.slice(0, MAX_BODY_BYTES) : buf
      const body = new TextDecoder('utf-8', { fatal: false }).decode(sliced)
      return makeOk({
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body,
        truncated,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return makeError('fetch_failed', msg, true)
    }
  },
}
