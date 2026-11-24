import { useTranslation } from 'react-i18next'
import type { ApprovalRequest } from '../shared/models'
import { ApprovalCard, type ApprovalCardStatus } from '@/components/beui/components/agents/approval-card'

export interface TaskApprovalCardProps {
  approval: ApprovalRequest
  busy?: boolean
  onResolve(decision: 'approved' | 'denied'): void
}

/** Maps Barn's durable Approval fact onto beUI's human-in-the-loop card. */
export function TaskApprovalCard({ approval, busy = false, onResolve }: TaskApprovalCardProps) {
  const { t } = useTranslation()
  const status: ApprovalCardStatus = busy
    ? 'submitting'
    : approval.status === 'approved'
      ? 'approved'
      : approval.status === 'denied'
        ? 'rejected'
        : 'pending'

  return (
    <div className="task-approval-card" data-approval-id={approval.id}>
      <ApprovalCard
        title={approval.title}
        description={approval.summary}
        status={status}
        onApprove={() => onResolve('approved')}
        onReject={() => onResolve('denied')}
        result={approval.status === 'approved'
          ? t('approvals.approvedResult')
          : approval.status === 'denied'
            ? t('approvals.deniedResult')
            : t('approvals.pendingResult')}
        labels={{
          title: t('approvals.title'),
          approve: t('approvals.approve'),
          reject: t('approvals.reject'),
          inputRequired: t('approvals.inputRequired'),
          submitting: t('approvals.submitting'),
          approved: t('approvals.approved'),
          rejected: t('approvals.rejected'),
        }}
      >
        {approval.details === undefined ? null : (
          <p className="task-approval-details">{approval.details}</p>
        )}
      </ApprovalCard>
    </div>
  )
}
