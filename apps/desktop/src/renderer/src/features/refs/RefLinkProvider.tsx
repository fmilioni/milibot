import { type ReactNode, useMemo, useState } from 'react'

import { workspaceKey } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { getKnowledgeDoc } from '@/features/knowledge/api'
import { ContentModal } from '@/features/knowledge/DocModals'
import { PlanDialog } from '@/features/plans/PlanDialog'
import { toastOnError } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { RefLinkContext, type RefLinkRenderers } from '@/ui/RefLinks'

import { openRef } from './open-ref'
import { PathLink } from './PathLink'
import { RefLink } from './RefLink'

function DocDialog({ docId, onClose }: { docId: string; onClose: () => void }) {
  const workspaceId = useWorkspaceId()
  const { data: doc } = useApiQuery(workspaceKey(workspaceId, 'knowledge', docId), () =>
    getKnowledgeDoc(workspaceId, docId),
  )
  return doc ? <ContentModal doc={doc} onClose={onClose} /> : null
}

/**
 * Makes ids of the app and `/workspace/` paths in every text below clickable (`ui/RefLinks.tsx`).
 * `navigable` false (windows without the main screens): ids show their names without opening anything.
 */
export function RefLinkProvider({
  children,
  navigable = true,
}: {
  children: ReactNode
  navigable?: boolean
}) {
  const [plan, setPlan] = useState<string | null>(null)
  const [doc, setDoc] = useState<string | null>(null)
  const renderers = useMemo<RefLinkRenderers>(() => {
    const dialogs = { openPlan: setPlan, openDoc: setDoc }
    const onOpen = navigable
      ? (info: Parameters<typeof openRef>[0]) => void toastOnError(openRef(info, dialogs))
      : undefined
    return {
      renderRef: (id, label) => <RefLink id={id} label={label} onOpen={onOpen} />,
      renderPath: (path, variant, label) => <PathLink path={path} variant={variant} label={label} />,
    }
  }, [navigable])
  return (
    <RefLinkContext.Provider value={renderers}>
      {children}
      {plan && <PlanDialog planId={plan} onClose={() => setPlan(null)} />}
      {doc && <DocDialog docId={doc} onClose={() => setDoc(null)} />}
    </RefLinkContext.Provider>
  )
}
