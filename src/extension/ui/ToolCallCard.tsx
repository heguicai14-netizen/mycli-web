interface Props {
  tool: string
  args: unknown
  status: 'running' | 'ok' | 'error'
  result?: string
}

export function ToolCallCard({ tool, args, status, result }: Props) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-mono font-semibold">{tool}</span>
        <span
          className={
            status === 'running'
              ? 'text-blue-600'
              : status === 'ok'
                ? 'text-green-600'
                : 'text-red-600'
          }
        >
          {status}
        </span>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-slate-500">args</summary>
        <pre className="mt-1 overflow-x-auto text-[11px]">{JSON.stringify(args, null, 2)}</pre>
      </details>
      {result && (
        <details className="mt-1">
          <summary className="cursor-pointer text-slate-500">result</summary>
          <pre className="mt-1 overflow-x-auto text-[11px]">{result.slice(0, 2000)}</pre>
        </details>
      )}
    </div>
  )
}
