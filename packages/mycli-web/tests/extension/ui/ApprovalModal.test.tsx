import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ApprovalModal } from '@ext/ui/ApprovalModal'

describe('ApprovalModal', () => {
  it('renders nothing when no pending approval', () => {
    render(<ApprovalModal pending={null} onReply={() => {}} />)
    expect(screen.queryByText(/approval needed/i)).toBeNull()
  })

  it('renders tool name, argsSummary, and origin when pending', () => {
    render(
      <ApprovalModal
        pending={{
          approvalId: 'a1',
          tool: 'readPage',
          argsSummary: 'Read https://example.com',
          origin: 'https://example.com',
        }}
        onReply={() => {}}
      />,
    )
    expect(screen.getByText(/readPage/)).toBeTruthy()
    expect(screen.getByText(/Read https:\/\/example.com/)).toBeTruthy()
    // origin appears as its own paragraph — getAllByText handles the fact that
    // argsSummary also contains "example.com"
    expect(screen.getAllByText(/example.com/i).length).toBeGreaterThan(0)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })

  it('calls onReply with correct decision on each button', () => {
    const onReply = vi.fn()
    render(
      <ApprovalModal
        pending={{ approvalId: 'a1', tool: 't', argsSummary: 's', origin: undefined }}
        onReply={onReply}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^once$/i }))
    expect(onReply).toHaveBeenLastCalledWith('a1', 'once')
    fireEvent.click(screen.getByRole('button', { name: /this session/i }))
    expect(onReply).toHaveBeenLastCalledWith('a1', 'session')
    fireEvent.click(screen.getByRole('button', { name: /always/i }))
    expect(onReply).toHaveBeenLastCalledWith('a1', 'always')
    fireEvent.click(screen.getByRole('button', { name: /deny/i }))
    expect(onReply).toHaveBeenLastCalledWith('a1', 'deny')
  })

  it('Esc key triggers deny', () => {
    const onReply = vi.fn()
    render(
      <ApprovalModal
        pending={{ approvalId: 'a1', tool: 't', argsSummary: 's', origin: undefined }}
        onReply={onReply}
      />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onReply).toHaveBeenLastCalledWith('a1', 'deny')
  })
})
