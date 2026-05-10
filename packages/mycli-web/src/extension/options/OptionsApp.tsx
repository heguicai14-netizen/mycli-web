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

        <fieldset className="rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-sm font-semibold text-slate-700">
            Auto-compaction
          </legend>
          <p className="mb-3 text-xs text-slate-500">
            When the conversation history exceeds the threshold, older messages
            are automatically summarized into a single system note so the chat
            can keep going without overflowing the model's context window.
          </p>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.autoCompact.enabled}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  autoCompact: { ...settings.autoCompact, enabled: e.target.checked },
                })
              }
            />
            <span className="text-sm">Enable auto-compaction</span>
          </label>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs font-medium text-slate-600">
                Model context window (tokens)
              </span>
              <input
                type="number"
                min={2000}
                max={2_000_000}
                step={1000}
                value={settings.autoCompact.modelContextWindow}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    autoCompact: {
                      ...settings.autoCompact,
                      modelContextWindow: Math.max(2000, Number(e.target.value) || 2000),
                    },
                  })
                }
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 font-mono text-sm"
              />
              <span className="mt-1 block text-[10px] text-slate-500">
                gpt-4o = 128000 · gpt-3.5 = 16000
              </span>
            </label>

            <label className="block">
              <span className="block text-xs font-medium text-slate-600">
                Threshold (% of context)
              </span>
              <input
                type="number"
                min={10}
                max={95}
                step={5}
                value={settings.autoCompact.thresholdPercent}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    autoCompact: {
                      ...settings.autoCompact,
                      thresholdPercent: Math.min(95, Math.max(10, Number(e.target.value) || 75)),
                    },
                  })
                }
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 font-mono text-sm"
              />
              <span className="mt-1 block text-[10px] text-slate-500">
                Triggers at{' '}
                {Math.floor(
                  (settings.autoCompact.modelContextWindow *
                    settings.autoCompact.thresholdPercent) /
                    100,
                ).toLocaleString()}{' '}
                tokens
              </span>
            </label>

            <label className="block">
              <span className="block text-xs font-medium text-slate-600">
                Keep recent messages
              </span>
              <input
                type="number"
                min={2}
                max={50}
                step={1}
                value={settings.autoCompact.keepRecentMessages}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    autoCompact: {
                      ...settings.autoCompact,
                      keepRecentMessages: Math.min(50, Math.max(2, Number(e.target.value) || 6)),
                    },
                  })
                }
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 font-mono text-sm"
              />
              <span className="mt-1 block text-[10px] text-slate-500">
                Last N messages stay verbatim
              </span>
            </label>
          </div>
        </fieldset>

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
