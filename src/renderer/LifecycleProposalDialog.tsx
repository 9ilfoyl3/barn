import { CalendarDays, Check, LoaderCircle, ShieldCheck, X } from 'lucide-react'
import type { LifecycleProposal } from '../shared/models'

interface LifecycleProposalDialogProps {
  proposal: LifecycleProposal
  busy: boolean
  error: string | undefined
  onDecision(decision: 'approve' | 'reject'): void
  onClose(): void
}

export function LifecycleProposalDialog({
  proposal,
  busy,
  error,
  onDecision,
  onClose,
}: LifecycleProposalDialogProps) {
  return (
    <div className="lifecycle-dialog-backdrop" role="presentation">
      <section
        className="lifecycle-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lifecycle-dialog-title"
      >
        <header>
          <div className="lifecycle-dialog-icon"><ShieldCheck size={18} /></div>
          <div>
            <span>Agent proposal · approval required</span>
            <h2 id="lifecycle-dialog-title">Lifecycle transition</h2>
          </div>
          <button type="button" aria-label="Close lifecycle proposal" disabled={busy} onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="lifecycle-employee">
          <strong>{proposal.displayName}</strong>
          <span>{proposal.employeeNo}</span>
        </div>

        <div className="lifecycle-transition">
          <span className={`workspace-status ${proposal.fromStatus}`}>{proposal.fromStatus}</span>
          <span className="lifecycle-arrow">→</span>
          <span className={`workspace-status ${proposal.toStatus}`}>{proposal.toStatus}</span>
        </div>

        <dl className="lifecycle-details">
          <div>
            <dt><CalendarDays size={13} />Effective date</dt>
            <dd>{proposal.effectiveDate}</dd>
          </div>
          <div>
            <dt>Reason</dt>
            <dd>{proposal.reason}</dd>
          </div>
          <div>
            <dt>Employee version</dt>
            <dd>v{proposal.employeeVersion}</dd>
          </div>
        </dl>

        {error !== undefined && <div className="lifecycle-error">{error}</div>}

        <p className="lifecycle-warning">
          Approval rechecks the employee version and current lifecycle state. No state changes
          until you confirm.
        </p>

        <footer>
          <button type="button" className="secondary" disabled={busy} onClick={() => onDecision('reject')}>
            Reject
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => onDecision('approve')}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
            {busy ? 'Submitting' : 'Approve transition'}
          </button>
        </footer>
      </section>
    </div>
  )
}
