import { Window } from 'happy-dom'

export function parseDom(html: string): Document {
  const win = new Window()
  win.document.write(html)
  return win.document as unknown as Document
}

export function htmlToText(html: string): string {
  const noScript = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  const noTags   = noScript.replace(/<[^>]+>/g, ' ')
  return noTags.replace(/\s+/g, ' ').trim()
}
