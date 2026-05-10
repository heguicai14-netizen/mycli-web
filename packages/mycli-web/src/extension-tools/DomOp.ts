import { z } from 'zod'

const Base = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  ts: z.number().int().nonnegative(),
})

const DomReadPage = Base.extend({
  kind: z.literal('dom/readPage'),
  tabId: z.number().int(),
  mode: z.enum(['text', 'markdown', 'html-simplified']),
})

const DomClick = Base.extend({
  kind: z.literal('dom/click'),
  tabId: z.number().int(),
  target: z.object({ selector: z.string(), all: z.boolean().optional() }),
})

const DomType = Base.extend({
  kind: z.literal('dom/type'),
  tabId: z.number().int(),
  target: z.object({ selector: z.string() }),
  value: z.string(),
})

const DomScreenshot = Base.extend({
  kind: z.literal('dom/screenshot'),
  tabId: z.number().int(),
})

export const DomOp = z.discriminatedUnion('kind', [
  DomReadPage,
  DomClick,
  DomType,
  DomScreenshot,
])
export type DomOp = z.infer<typeof DomOp>
