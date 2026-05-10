import { toOpenAiTool } from './Tool'
import type { ToolDefinition } from './types'

export class ToolRegistry {
  private map = new Map<string, ToolDefinition<any, any, any>>()

  register(def: ToolDefinition<any, any, any>): void {
    if (this.map.has(def.name)) throw new Error(`duplicate tool name: ${def.name}`)
    this.map.set(def.name, def)
  }

  get(name: string): ToolDefinition<any, any, any> | undefined {
    return this.map.get(name)
  }

  all(): ToolDefinition<any, any, any>[] {
    return Array.from(this.map.values())
  }

  toOpenAi() {
    return this.all().map(toOpenAiTool)
  }
}
