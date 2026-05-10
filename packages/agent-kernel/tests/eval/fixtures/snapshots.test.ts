import { describe, it, expect } from 'vitest'
import { makeFsLoader } from '../../../eval/fixtures/ctx'
import path from 'node:path'

const root = path.resolve(__dirname, '../../../eval/fixtures/snapshots')
const load = makeFsLoader(root)

const REQUIRED = [
  'github-issue-1234.html', 'selection-paragraph.html',
  'landing-page.html', 'product-page.html', 'blog-list.html',
  'pr-page.html', 'article.html', 'exp-dashboard-12345.html',
  'multi-tab-context/tab-a.html', 'multi-tab-context/tab-b.html',
  'page-with-error.html', 'page-clean.html',
]

describe('snapshots', () => {
  for (const name of REQUIRED) {
    it(`exists and parses: ${name}`, () => {
      const s = load(name)
      expect(s, name).toBeDefined()
      expect(s!.length).toBeGreaterThan(50)
    })
  }
})
