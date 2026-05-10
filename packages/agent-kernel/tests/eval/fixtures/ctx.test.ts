import { describe, it, expect } from 'vitest'
import { makeFixtureCtx } from '../../../eval/fixtures/ctx'
import { htmlToText, parseDom } from '../../../eval/fixtures/htmlUtils'
import type { Task } from '../../../eval/core/types'

const tinyTask: Task = {
  id: 't', level: 'L1', prompt: '', fixtures: {},
  judge: {}, budget: { expectedSteps: 1, expectedTokens: 1, expectedDurMs: 1, maxSteps: 1 },
}

describe('makeFixtureCtx', () => {
  it('exposes task + state map', () => {
    const ctx = makeFixtureCtx(tinyTask, () => undefined, () => undefined)
    expect(ctx.task).toBe(tinyTask)
    expect(ctx.state).toBeInstanceOf(Map)
  })

  it('loadSnapshot returns content from injected loader', () => {
    const ctx = makeFixtureCtx(tinyTask, (n) => (n === 'a.html' ? '<p>hi</p>' : undefined), () => undefined)
    expect(ctx.loadSnapshot('a.html')).toBe('<p>hi</p>')
    expect(ctx.loadSnapshot('missing.html')).toBeUndefined()
  })
})

describe('htmlUtils', () => {
  it('htmlToText strips tags and collapses whitespace', () => {
    expect(htmlToText('<h1>Title</h1><p>Body  text.</p>')).toBe('Title Body text.')
  })
  it('parseDom returns a happy-dom Document', () => {
    const doc = parseDom('<div class="x">hello</div>')
    expect(doc.querySelector('.x')?.textContent).toBe('hello')
  })
})
