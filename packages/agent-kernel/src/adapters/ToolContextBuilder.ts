/**
 * Builds the per-turn ToolExecContext extension that gets merged into
 * each tool's `ctx` parameter. Consumers know what fields their tools
 * need (e.g. tabId, rpc); the kernel stays agnostic.
 *
 * `cid` is the active conversation id, or undefined for ephemeral turns.
 */
export interface ToolContextBuilder<
  Ctx extends Record<string, unknown> = Record<string, unknown>,
> {
  build(cid: string | undefined): Promise<Ctx>
}
