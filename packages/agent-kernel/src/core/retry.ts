// packages/agent-kernel/src/core/retry.ts

export interface RetryConfig {
  /** Total retry attempts after the first try. 0 = no retry. Default callers use 2 → 3 total tries. */
  maxRetries: number
  /** Base delay in ms. Actual delay = baseMs * 2^attempt + Math.random() * baseMs. */
  baseMs: number
}

/**
 * Run `fn`, retry on errors classified retryable by `isRetryable`.
 * Stops when: fn succeeds, fn throws non-retryable, or attempts > maxRetries.
 *
 * Delay schedule for baseMs=500: ~500ms, ~2s (jitter 0-500ms added each).
 */
export async function withRetryBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  isRetryable: (err: unknown) => boolean,
  cfg: RetryConfig,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      lastErr = err
      if (!isRetryable(err) || attempt === cfg.maxRetries) throw err
      const delay = cfg.baseMs * Math.pow(2, attempt) + Math.random() * cfg.baseMs
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}
