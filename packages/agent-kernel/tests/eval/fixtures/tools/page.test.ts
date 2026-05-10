import { describe, it, expect } from 'vitest'
import { makeFixtureCtx } from '../../../../eval/fixtures/ctx'
import { makeFakeReadPage } from '../../../../eval/fixtures/tools/fakeReadPage'
import { makeFakeReadSelection } from '../../../../eval/fixtures/tools/fakeReadSelection'
import { makeFakeQuerySelector } from '../../../../eval/fixtures/tools/fakeQuerySelector'

const SNAP = `
<html><body>
  <h1>Hello world</h1>
  <p class="intro">Intro text.</p>
  <p>Body text.</p>
  <!-- SELECTION -->Selected paragraph here.<!-- /SELECTION -->
</body></html>
`
const task: any = {
  id: 't', level: 'L1', prompt: '', judge: {},
  fixtures: { snapshot: 'a.html' },
  budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 1 },
}

function ctx() {
  return makeFixtureCtx(task, (n) => (n === 'a.html' ? SNAP : undefined), () => undefined)
}

describe('fakeReadPage', () => {
  it('returns text from active snapshot', async () => {
    const tool = makeFakeReadPage(ctx())
    const r = await tool.execute({}, {})
    expect(r.ok).toBe(true)
    expect((r.data as any).text).toMatch(/Hello world/)
  })
  it('returns error when no snapshot bound', async () => {
    const t2: any = { ...task, fixtures: {} }
    const c = makeFixtureCtx(t2, () => undefined, () => undefined)
    const r = await makeFakeReadPage(c).execute({}, {})
    expect(r.ok).toBe(false)
  })
})

describe('fakeReadSelection', () => {
  it('returns text between SELECTION markers', async () => {
    const r = await makeFakeReadSelection(ctx()).execute({}, {})
    expect(r.ok).toBe(true)
    expect((r.data as any).text).toBe('Selected paragraph here.')
  })
})

describe('fakeQuerySelector', () => {
  it('returns matched element textContent', async () => {
    const r = await makeFakeQuerySelector(ctx()).execute({ selector: 'h1' }, {})
    expect(r.ok).toBe(true)
    expect((r.data as any).text).toBe('Hello world')
  })
  it('returns ok:false when selector matches nothing', async () => {
    const r = await makeFakeQuerySelector(ctx()).execute({ selector: '.missing' }, {})
    expect(r.ok).toBe(false)
  })
})
