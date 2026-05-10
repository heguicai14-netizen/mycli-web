import { describe, it, expect } from 'vitest'
import { makeFixtureCtx } from '../../../../eval/fixtures/ctx'
import { makeFakeListTabs } from '../../../../eval/fixtures/tools/fakeListTabs'
import { makeFakeScreenshot } from '../../../../eval/fixtures/tools/fakeScreenshot'
import { makeFakeFetch } from '../../../../eval/fixtures/tools/fakeFetch'
import { makeFakeUseSkill } from '../../../../eval/fixtures/tools/fakeUseSkill'

const baseTask: any = {
  id: 't', level: 'L1', prompt: '', judge: {},
  fixtures: {},
  budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 1 },
}

describe('fakeListTabs', () => {
  it('returns task.fixtures.tabs', async () => {
    const t = { ...baseTask, fixtures: { tabs: ['a.html', 'b.html'] } }
    const c = makeFixtureCtx(t, () => '<title>t</title>', () => undefined)
    const r = await makeFakeListTabs(c).execute({}, {})
    expect(r.ok).toBe(true)
    expect((r.data as any).tabs).toHaveLength(2)
  })
})

describe('fakeScreenshot', () => {
  it('returns caption from companion .caption.txt', async () => {
    const t = { ...baseTask, fixtures: { snapshot: 'a.html' } }
    const c = makeFixtureCtx(t, () => '<p/>', (n) => (n === 'a.html' ? 'Screenshot of a landing page' : undefined))
    const r = await makeFakeScreenshot(c).execute({}, {})
    expect(r.ok).toBe(true)
    expect((r.data as any).caption).toBe('Screenshot of a landing page')
  })
  it('default caption when no companion file', async () => {
    const t = { ...baseTask, fixtures: { snapshot: 'a.html' } }
    const c = makeFixtureCtx(t, () => '<p/>', () => undefined)
    const r = await makeFakeScreenshot(c).execute({}, {})
    expect(r.ok).toBe(true)
  })
})

describe('fakeFetch', () => {
  it('returns body from fetchMap', async () => {
    const t = { ...baseTask, fixtures: { fetchMap: { 'http://x/y': 'hello' } } }
    const c = makeFixtureCtx(t, () => undefined, () => undefined)
    const r = await makeFakeFetch(c).execute({ url: 'http://x/y' }, {})
    expect(r.ok).toBe(true)
    expect((r.data as any).body).toBe('hello')
  })
  it('errors on url not in fetchMap', async () => {
    const t = { ...baseTask, fixtures: { fetchMap: {} } }
    const c = makeFixtureCtx(t, () => undefined, () => undefined)
    const r = await makeFakeFetch(c).execute({ url: 'http://nope' }, {})
    expect(r.ok).toBe(false)
  })
  it('failOnce: first call fails, subsequent succeed', async () => {
    const t = { ...baseTask, fixtures: { fetchMap: { 'http://x': { body: 'ok', failOnce: true } } } }
    const c = makeFixtureCtx(t, () => undefined, () => undefined)
    const tool = makeFakeFetch(c)
    const r1 = await tool.execute({ url: 'http://x' }, {})
    expect(r1.ok).toBe(false)
    const r2 = await tool.execute({ url: 'http://x' }, {})
    expect(r2.ok).toBe(true)
    expect((r2.data as any).body).toBe('ok')
  })
  it('falls back to loadSnapshot for fixture:// URLs (multi-tab tasks)', async () => {
    const t = { ...baseTask, fixtures: { tabs: ['multi/tab-a.html'] } }
    const c = makeFixtureCtx(
      t,
      (name) => (name === 'multi/tab-a.html' ? '<title>A</title><body>tab a body</body>' : undefined),
      () => undefined,
    )
    const r = await makeFakeFetch(c).execute({ url: 'fixture://multi/tab-a.html' }, {})
    expect(r.ok).toBe(true)
    expect((r.data as any).body).toContain('tab a body')
    expect((r.data as any).status).toBe(200)
  })
  it('still errors when fixture:// URL has no matching snapshot', async () => {
    const t = { ...baseTask, fixtures: {} }
    const c = makeFixtureCtx(t, () => undefined, () => undefined)
    const r = await makeFakeFetch(c).execute({ url: 'fixture://does-not-exist.html' }, {})
    expect(r.ok).toBe(false)
  })
  it('fetchMap entry takes precedence over fixture:// fallback', async () => {
    const t = {
      ...baseTask,
      fixtures: { fetchMap: { 'fixture://a.html': 'override' } },
    }
    const c = makeFixtureCtx(t, () => 'snapshot-content', () => undefined)
    const r = await makeFakeFetch(c).execute({ url: 'fixture://a.html' }, {})
    expect(r.ok).toBe(true)
    expect((r.data as any).body).toBe('override')
  })
})

describe('fakeUseSkill', () => {
  it('returns body for known skill', async () => {
    const t = { ...baseTask, fixtures: { skills: { summarizePage: 'You are a summarizer...' } } }
    const c = makeFixtureCtx(t, () => undefined, () => undefined)
    const r = await makeFakeUseSkill(c).execute({ name: 'summarizePage' }, {})
    expect(r.ok).toBe(true)
    expect((r.data as any).body).toContain('summarizer')
  })
  it('errors for unknown skill', async () => {
    const c = makeFixtureCtx(baseTask, () => undefined, () => undefined)
    const r = await makeFakeUseSkill(c).execute({ name: 'missing' }, {})
    expect(r.ok).toBe(false)
  })
})
