import { useEffect } from 'react'

export interface PendingApproval {
  approvalId: string
  tool: string
  argsSummary: string
  origin?: string
}

export interface ApprovalModalProps {
  pending: PendingApproval | null
  onReply: (approvalId: string, decision: 'once' | 'session' | 'always' | 'deny') => void
}

export function ApprovalModal({ pending, onReply }: ApprovalModalProps) {
  // Esc listener on `document` (not the Shadow root) — keydown events bubble
  // out of Shadow DOM, so this works for closed-mode shadow roots too.
  useEffect(() => {
    if (!pending) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onReply(pending.approvalId, 'deny')
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [pending, onReply])

  if (!pending) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Approval needed"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2147483647,
      }}
    >
      <div
        style={{
          background: 'white',
          padding: 24,
          borderRadius: 8,
          maxWidth: 480,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <h3 style={{ margin: '0 0 12px' }}>Approval needed</h3>
        <p style={{ margin: '4px 0' }}>
          <strong>Tool:</strong> {pending.tool}
        </p>
        <p style={{ margin: '4px 0' }}>
          <strong>Action:</strong> {pending.argsSummary}
        </p>
        {pending.origin && (
          <p style={{ margin: '4px 0' }}>
            <strong>Origin:</strong> {pending.origin}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <button onClick={() => onReply(pending.approvalId, 'once')}>Once</button>
          <button onClick={() => onReply(pending.approvalId, 'session')}>This Session</button>
          <button onClick={() => onReply(pending.approvalId, 'always')}>Always</button>
          <button onClick={() => onReply(pending.approvalId, 'deny')}>Deny</button>
        </div>
      </div>
    </div>
  )
}
