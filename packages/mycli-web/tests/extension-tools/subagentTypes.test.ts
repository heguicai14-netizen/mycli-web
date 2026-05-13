import { describe, it, expect } from 'vitest'
import { allSubagentTypes } from '../../src/extension-tools/subagentTypes'
import { extensionTools } from '../../src/extension-tools'

// Kernel-shipped tools that the kernel itself appends to the registry at boot
// (todoWrite is conditionally added by bootKernelOffscreen when todoStore is
// enabled; fetchGet is the kernel's default tool). Sub-agent types whitelist
// these by name even though they're not in `extensionTools`.
const KERNEL_SHIPPED_TOOLS = new Set(['todoWrite', 'fetchGet'])

describe('subagentTypes — static guards', () => {
  it('every allowedTools entry exists in the extension or kernel tool set', () => {
    const known = new Set([
      ...extensionTools.map((t) => t.name),
      ...KERNEL_SHIPPED_TOOLS,
    ])
    for (const type of allSubagentTypes) {
      if (type.allowedTools === '*') continue
      for (const name of type.allowedTools) {
        expect(known, `unknown tool "${name}" in subagent type ${type.name}`).toContain(name)
      }
    }
  })

  it('every subagent name matches the kernel constraint', () => {
    for (const t of allSubagentTypes) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_-]*$/)
    }
  })
})
