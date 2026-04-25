import { toOpenAiTool } from '@/agent/Tool'
import type { ToolDefinition } from '@shared/types'

export class ToolRegistry {
  private map = new Map<string, ToolDefinition>()

  register(def: ToolDefinition): void {
    if (this.map.has(def.name)) throw new Error(`duplicate tool name: ${def.name}`)
    this.map.set(def.name, def)
  }

  get(name: string): ToolDefinition | undefined {
    return this.map.get(name)
  }

  all(): ToolDefinition[] {
    return Array.from(this.map.values())
  }

  toOpenAi() {
    return this.all().map(toOpenAiTool)
  }
}
