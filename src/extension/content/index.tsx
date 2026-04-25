import { createRoot } from 'react-dom/client'
import { StrictMode, useState, useEffect } from 'react'
import { Fab, ChatShell } from './fab'
import { RpcClient } from '../rpc/client'
import { getTransientUi, setTransientUi } from '../storage/transient'
import { loadSettings } from '../storage/settings'
import contentCss from '../../styles/content.css?inline'

async function mount() {
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

  const client = new RpcClient({ portName: 'session' })
  await client.connect()

  function App() {
    const [open, setOpen] = useState(false)
    useEffect(() => {
      getTransientUi().then((s) => setOpen(s.panelOpen))
      const listener = (msg: any) => {
        if (msg?.kind === 'content/activate') setOpen(true)
      }
      chrome.runtime.onMessage.addListener(listener)
      return () => chrome.runtime.onMessage.removeListener(listener)
    }, [])

    async function toggle() {
      const next = !open
      setOpen(next)
      await setTransientUi({ panelOpen: next })
    }

    return (
      <StrictMode>
        <Fab onClick={toggle} position={settings.fab.position} />
        {open && <ChatShell />}
      </StrictMode>
    )
  }

  createRoot(mountNode).render(<App />)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mount())
} else {
  mount()
}
