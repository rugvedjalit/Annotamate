import { useQuery } from '@tanstack/react-query'
import { PanelRightClose } from 'lucide-react'
import { getComments } from '@/lib/endpoints'
import { qk } from '@/lib/queryKeys'
import { useUi } from '@/stores/ui'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { IconButton } from '@/components/ui/IconButton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { CommentsTab } from './CommentsTab'
import { HistoryTab } from './HistoryTab'
import { InfoTab } from './InfoTab'
import { LabelsTab } from './LabelsTab'
import { useAnnotator, type InspectorTab } from './store'
import { useWorkspace } from './workspaceContext'

const TAB = 'group-data-[variant=underline]/tabs:px-1.5'

/** Right panel: Labels (classes, objects, properties) · Comments · History · Info. */
export function Inspector() {
  const ws = useWorkspace()
  const tab = useAnnotator((s) => s.inspectorTab)
  const setTab = useAnnotator((s) => s.setInspectorTab)
  const setInspectorOpen = useUi((s) => s.setInspectorOpen)
  const comments = useQuery({
    queryKey: qk.comments(ws.projectId, ws.imageId),
    queryFn: ({ signal }) => getComments(ws.projectId, ws.imageId, { signal }),
    staleTime: 30_000,
  })
  const open = comments.data?.filter((c) => !c.resolved && !c.deleted).length ?? ws.image?.open_comment_count ?? 0

  return (
    <aside aria-label="Inspector" className="flex h-full min-h-0 flex-col bg-panel">
      <Tabs value={tab} onValueChange={(v) => setTab(v as InspectorTab)} className="flex h-full min-h-0 flex-col">
        <div className="flex items-center border-b border-line pr-1">
          <TabsList className="min-w-0 flex-1 gap-0 overflow-hidden border-b-0 px-1">
            <TabsTrigger value="labels" className={TAB}>
              Labels
            </TabsTrigger>
            <TabsTrigger value="comments" className={TAB}>
              Comments
              {open > 0 && (
                <span className="grid h-4 min-w-4 place-items-center rounded-full bg-warn px-1 text-[10px] font-bold text-white">
                  {open}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="history" className={TAB}>
              History
            </TabsTrigger>
            <TabsTrigger value="info" className={TAB}>
              Info
            </TabsTrigger>
          </TabsList>
          <IconButton size="sm" className="shrink-0" label="Hide inspector" icon={<PanelRightClose />} onClick={() => setInspectorOpen(false)} />
        </div>
        <TabsContent value="labels" className="min-h-0 flex-1">
          <ErrorBoundary name="Labels" resetKey={ws.imageId}>
            <LabelsTab />
          </ErrorBoundary>
        </TabsContent>
        <TabsContent value="comments" className="min-h-0 flex-1">
          <ErrorBoundary name="Comments" resetKey={ws.imageId}>
            <CommentsTab />
          </ErrorBoundary>
        </TabsContent>
        <TabsContent value="history" className="min-h-0 flex-1">
          <ErrorBoundary name="History" resetKey={ws.imageId}>
            <HistoryTab />
          </ErrorBoundary>
        </TabsContent>
        <TabsContent value="info" className="min-h-0 flex-1">
          <ErrorBoundary name="Info" resetKey={ws.imageId}>
            <InfoTab />
          </ErrorBoundary>
        </TabsContent>
      </Tabs>
    </aside>
  )
}
