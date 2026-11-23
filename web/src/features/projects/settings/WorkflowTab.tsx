import { toast } from 'sonner'
import type { Project, ProjectSettings } from '@/lib/types'
import { SwitchRow } from '@/components/ui/Switch'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { SettingsCard } from './SettingsCard'
import { useUpdateProject } from './settingsHooks'

export function WorkflowTab({ project }: { project: Project }) {
  const update = useUpdateProject(project.id)
  const s = project.settings

  function set(patch: Partial<ProjectSettings>, message: string) {
    update.mutate({ settings: patch }, { onSuccess: () => toast.success(message) })
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsCard title="Review and permissions" description="Changes apply immediately for everyone in the project.">
        <div className="divide-y divide-line">
          <SwitchRow
            label="Require review"
            description="Submitting sends an image to “In review”; a reviewer approves or rejects it before it counts as done."
            checked={s.require_review}
            onCheckedChange={(v) => set({ require_review: v }, v ? 'Review is now required' : 'Review is now optional')}
          />
          <SwitchRow
            label="Only edit assigned images"
            description="Annotators can edit images assigned to them, or unassigned images (which they claim on first save)."
            checked={s.restrict_to_assigned}
            onCheckedChange={(v) =>
              set({ restrict_to_assigned: v }, v ? 'Annotators now edit only their images' : 'Annotators can edit any image')
            }
          />
          <SwitchRow
            label="Annotators can add classes"
            description="When off, only reviewers and managers can create new classes from the class picker."
            checked={s.annotators_can_add_classes}
            onCheckedChange={(v) =>
              set({ annotators_can_add_classes: v }, v ? 'Annotators can add classes' : 'Only reviewers and managers add classes')
            }
          />
        </div>
      </SettingsCard>

      <SettingsCard title="Images" description="How the server reads the image folder.">
        <div className="flex flex-col divide-y divide-line">
          <div className="flex flex-wrap items-start justify-between gap-4 py-2">
            <div className="min-w-0 max-w-md">
              <div className="text-base text-fg">EXIF orientation</div>
              <div className="mt-0.5 text-sm text-muted">
                “Apply” rotates phone photos the way OpenCV and Ultralytics loaders do, so boxes line up at training time.
              </div>
            </div>
            <SegmentedControl
              aria-label="EXIF orientation"
              value={s.exif_mode}
              onValueChange={(v) => set({ exif_mode: v }, v === 'apply' ? 'EXIF orientation is applied' : 'EXIF orientation is ignored')}
              options={[
                { value: 'apply', label: 'Apply' },
                { value: 'ignore', label: 'Ignore' },
              ]}
            />
          </div>
          <SwitchRow
            label="Include sub-folders"
            description="Scan nested folders too. Rescan the project (General) to pick up the change."
            checked={s.recursive}
            onCheckedChange={(v) => set({ recursive: v }, v ? 'Sub-folders are included' : 'Sub-folders are excluded')}
          />
        </div>
      </SettingsCard>
    </div>
  )
}
