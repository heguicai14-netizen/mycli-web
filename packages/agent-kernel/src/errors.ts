export enum ErrorCode {
  Network = 'network',
  Auth = 'auth',
  RateLimit = 'rate_limit',
  BadRequest = 'bad_request',
  Server = 'server',
  Timeout = 'timeout',
  Abort = 'abort',
  ToolError = 'tool_error',
  Schema = 'schema',
  Unknown = 'unknown',
}

export interface ClassifiedError {
  code: ErrorCode
  message: string
  retryable: boolean
  cause?: unknown
}

export function classifyError(e: unknown): ClassifiedError {
  // AbortError
  if (e && typeof e === 'object' && (e as any).name === 'AbortError') {
    return { code: ErrorCode.Abort, message: 'aborted', retryable: false, cause: e }
  }

  // Errors with a numeric `status` (set by OpenAICompatibleClient on HTTP failures)
  const status = (e as any)?.status as number | undefined
  if (typeof status === 'number') {
    if (status === 401 || status === 403) {
      return {
        code: ErrorCode.Auth,
        message: (e as Error).message ?? `HTTP ${status}`,
        retryable: false,
        cause: e,
      }
    }
    if (status === 429) {
      return {
        code: ErrorCode.RateLimit,
        message: (e as Error).message ?? `HTTP ${status}`,
        retryable: true,
        cause: e,
      }
    }
    if (status >= 500 && status < 600) {
      return {
        code: ErrorCode.Server,
        message: (e as Error).message ?? `HTTP ${status}`,
        retryable: true,
        cause: e,
      }
    }
    if (status >= 400 && status < 500) {
      return {
        code: ErrorCode.BadRequest,
        message: (e as Error).message ?? `HTTP ${status}`,
        retryable: false,
        cause: e,
      }
    }
  }

  // Node-style network errors expose a `code` field (ECONNRESET, ECONNREFUSED,
  // ETIMEDOUT, EAI_AGAIN, EPIPE, ENETUNREACH). These are transient connection
  // failures — retry is safe and the right move when they happen before any
  // bytes of the response body are consumed.
  const nodeCode = (e as any)?.code
  if (typeof nodeCode === 'string') {
    const retryableNetCodes = new Set([
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'EPIPE',
      'ENETUNREACH',
      'ENOTFOUND',
    ])
    if (retryableNetCodes.has(nodeCode)) {
      return {
        code: ErrorCode.Network,
        message: (e as Error)?.message ?? nodeCode,
        retryable: true,
        cause: e,
      }
    }
  }

  // Message-pattern matching
  const msg =
    e instanceof Error
      ? e.message
      : typeof e === 'string'
        ? e
        : JSON.stringify(e)
  if (/timeout/i.test(msg)) {
    return { code: ErrorCode.Timeout, message: msg, retryable: true, cause: e }
  }
  if (e instanceof TypeError && /fetch/i.test(msg)) {
    return { code: ErrorCode.Network, message: msg, retryable: true, cause: e }
  }
  // Bare "ECONNRESET"-style messages (no code field) — common in Node fetch
  // wrappers that re-throw without preserving the .code field.
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENETUNREACH|ENOTFOUND/.test(msg)) {
    return { code: ErrorCode.Network, message: msg, retryable: true, cause: e }
  }

  return {
    code: ErrorCode.Unknown,
    message: typeof msg === 'string' ? msg : String(msg),
    retryable: false,
    cause: e,
  }
}
