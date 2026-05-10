function readPage(mode: 'text' | 'markdown' | 'html-simplified') {
  if (mode === 'text') {
    return {
      ok: true as const,
      data: {
        text: document.body?.innerText ?? '',
        url: location.href,
        title: document.title,
      },
    }
  }
  if (mode === 'html-simplified') {
    return {
      ok: true as const,
      data: {
        text: document.body?.outerHTML?.slice(0, 100_000) ?? '',
        url: location.href,
        title: document.title,
      },
    }
  }
  // markdown: very rough — convert headings + paragraphs only
  const lines: string[] = []
  document.querySelectorAll('h1, h2, h3, p, li').forEach((el) => {
    const tag = el.tagName.toLowerCase()
    const text = (el.textContent ?? '').trim()
    if (!text) return
    if (tag === 'h1') lines.push(`# ${text}`)
    else if (tag === 'h2') lines.push(`## ${text}`)
    else if (tag === 'h3') lines.push(`### ${text}`)
    else if (tag === 'li') lines.push(`- ${text}`)
    else lines.push(text)
  })
  return {
    ok: true as const,
    data: {
      text: lines.join('\n\n'),
      url: location.href,
      title: document.title,
    },
  }
}

function readSelection() {
  const sel = window.getSelection()?.toString() ?? ''
  return { ok: true as const, data: { text: sel } }
}

function querySelectorOp(selector: string, all: boolean) {
  let nodes: Element[] = []
  try {
    if (all) {
      nodes = Array.from(document.querySelectorAll(selector))
    } else {
      const first = document.querySelector(selector)
      nodes = first ? [first] : []
    }
  } catch (e: any) {
    return {
      ok: false as const,
      error: { code: 'invalid_selector', message: e?.message ?? '', retryable: false },
    }
  }
  return {
    ok: true as const,
    data: {
      matches: nodes.slice(0, 20).map((el) => {
        const r = el.getBoundingClientRect()
        return {
          text: (el.textContent ?? '').trim().slice(0, 500),
          outerHtml: el.outerHTML.slice(0, 2000),
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        }
      }),
    },
  }
}

export function installDomHandlers() {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.kind !== 'dom_op') return false
    const { op } = msg
    try {
      if (op.kind === 'dom/readPage') {
        sendResponse(readPage(op.mode))
      } else if (op.kind === 'dom/readSelection') {
        sendResponse(readSelection())
      } else if (op.kind === 'dom/querySelector') {
        sendResponse(querySelectorOp(op.selector, op.all ?? false))
      } else {
        sendResponse({
          ok: false,
          error: { code: 'unknown_op', message: op.kind, retryable: false },
        })
      }
    } catch (e: any) {
      sendResponse({
        ok: false,
        error: { code: 'handler_error', message: e?.message ?? String(e), retryable: false },
      })
    }
    return true
  })
}
