import { z } from 'zod'

export const ApprovalRule = z.object({
  id: z.string().uuid(),
  tool: z.string(),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('global') }),
    z.object({ kind: z.literal('origin'), origin: z.string() }),
    z.object({
      kind: z.literal('originAndSelector'),
      origin: z.string(),
      selectorPattern: z.string(),
    }),
    z.object({ kind: z.literal('urlPattern'), pattern: z.string() }),
  ]),
  decision: z.enum(['allow', 'deny']),
  expiresAt: z.number().optional(),
  createdAt: z.number(),
})
export type ApprovalRule = z.infer<typeof ApprovalRule>

const KEY = 'mycliWebRules'

async function readRules(): Promise<ApprovalRule[]> {
  const r = await chrome.storage.local.get(KEY)
  const raw = r[KEY]
  if (!Array.isArray(raw)) return []
  return raw.flatMap((x) => {
    const p = ApprovalRule.safeParse(x)
    return p.success ? [p.data] : []
  })
}

async function writeRules(rules: ApprovalRule[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: rules })
}

export async function listRules(): Promise<ApprovalRule[]> {
  return readRules()
}

export async function addRule(input: {
  tool: string
  scope: ApprovalRule['scope']
  decision: ApprovalRule['decision']
  expiresAt?: number
}): Promise<ApprovalRule> {
  const rules = await readRules()
  const row: ApprovalRule = {
    id: crypto.randomUUID(),
    tool: input.tool,
    scope: input.scope,
    decision: input.decision,
    expiresAt: input.expiresAt,
    createdAt: Date.now(),
  }
  rules.push(row)
  await writeRules(rules)
  return row
}

export async function removeRule(id: string): Promise<void> {
  const rules = await readRules()
  await writeRules(rules.filter((r) => r.id !== id))
}

function specificity(scope: ApprovalRule['scope']): number {
  switch (scope.kind) {
    case 'originAndSelector':
      return 3
    case 'origin':
      return 2
    case 'urlPattern':
      return 1
    case 'global':
      return 0
  }
}

function matchesScope(
  scope: ApprovalRule['scope'],
  query: { origin?: string; selector?: string; url?: string },
): boolean {
  switch (scope.kind) {
    case 'global':
      return true
    case 'origin':
      return query.origin === scope.origin
    case 'originAndSelector': {
      if (query.origin !== scope.origin) return false
      if (!query.selector) return false
      return query.selector === scope.selectorPattern || new RegExp(scope.selectorPattern).test(query.selector)
    }
    case 'urlPattern':
      if (!query.url) return false
      return new RegExp(scope.pattern).test(query.url)
  }
}

export async function findMatchingRule(query: {
  tool: string
  origin?: string
  selector?: string
  url?: string
}): Promise<ApprovalRule | undefined> {
  const now = Date.now()
  const candidates = (await readRules())
    .filter((r) => r.tool === query.tool)
    .filter((r) => r.expiresAt === undefined || r.expiresAt > now)
    .filter((r) => matchesScope(r.scope, query))
  if (candidates.length === 0) return undefined
  candidates.sort((a, b) => specificity(b.scope) - specificity(a.scope))
  return candidates[0]
}
