import { createRoot } from 'react-dom/client'
import { StrictMode } from 'react'
import { ChatApp } from './ChatApp'
import { installDomHandlers } from '@ext-tools/content/domHandlers'
import { loadSettings } from '../storage/settings'
import contentCss from '../../styles/content.css?inline'

async function mount() {
  // Always install DOM handlers — agent should be able to drive this tab even if
  // the user has hidden the FAB via settings.
  installDomHandlers()

  const settings = await loadSettings()
  if (!settings.fab.enabled) return

  // Build Shadow DOM host to isolate from page styles.
  const host = document.createElement('div')
  host.id = 'mycli-web-root'
  host.style.all = 'initial'
  document.documentElement.appendChild(host)
  const shadow = host.attachShadow({ mode: 'closed' })

  // Inject Tailwind + Shadow DOM reset.
  const styleEl = document.createElement('style')
  styleEl.textContent = contentCss
  shadow.appendChild(styleEl)

  const mountNode = document.createElement('div')
  mountNode.id = 'mycli-web-mount'
  shadow.appendChild(mountNode)

  createRoot(mountNode).render(
    <StrictMode>
      <ChatApp />
    </StrictMode>,
  )
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mount())
} else {
  mount()
}
