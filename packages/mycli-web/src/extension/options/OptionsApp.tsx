import { createRoot } from 'react-dom/client'
import { StrictMode, useEffect, useState } from 'react'
import { loadSettings, saveSettings, type Settings } from '@ext/storage/settings'

function OptionsApp() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    loadSettings().then(setSettings)
  }, [])

  if (!settings) return <div className="p-6">Loading…</div>

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!settings) return
    await saveSettings(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-bold">mycli-web settings</h1>
      <p className="mt-1 text-sm text-slate-500">Plan A — minimal settings form.</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="block">
          <span className="block text-sm font-medium">API key</span>
          <input
            type="password"
            value={settings.apiKey}
            onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 font-mono text-sm"
          />
        </label>
        <label className="block">
          <span className="block text-sm font-medium">Base URL</span>
          <input
            type="text"
            value={settings.baseUrl}
            onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 font-mono text-sm"
          />
        </label>
        <label className="block">
          <span className="block text-sm font-medium">Model</span>
          <input
            type="text"
            value={settings.model}
            onChange={(e) => setSettings({ ...settings, model: e.target.value })}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 font-mono text-sm"
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Save
          </button>
          {saved && <span className="text-sm text-green-600">Saved ✓</span>}
        </div>
      </form>
    </div>
  )
}

const root = document.getElementById('options-root')!
createRoot(root).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
)
