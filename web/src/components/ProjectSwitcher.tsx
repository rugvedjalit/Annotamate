import { useNavigate } from 'react-router'
import { Check, ChevronDown, Database, LayoutGrid } from 'lucide-react'
import type { Project } from '@/lib/types'
import { useProjects } from '@/hooks/queries'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { FormatBadge } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Feedback'
import { cn } from '@/lib/utils'

interface ProjectSwitcherProps {
  project: Project
  /** Where to go when another project is picked (default: its overview). */
  target?: 'overview' | 'annotate'
  className?: string
}

export function ProjectSwitcher({ project, target = 'overview', className }: ProjectSwitcherProps) {
  const navigate = useNavigate()
  const { data: projects, isPending } = useProjects(false)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex h-[30px] min-w-0 max-w-[280px] items-center gap-2 rounded-md px-2 text-base hover:bg-hover data-[state=open]:bg-hover',
          className,
        )}
        aria-label={`Project: ${project.name}. Switch project`}
      >
        <Database className="size-3.5 shrink-0 text-muted" aria-hidden />
        <span className="truncate font-medium">{project.name}</span>
        <FormatBadge format={project.label_format} />
        <ChevronDown className="size-3 shrink-0 text-muted" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] w-72 overflow-y-auto">
        <DropdownMenuLabel>Switch project</DropdownMenuLabel>
        {isPending && (
          <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted">
            <Spinner /> Loading projects
          </div>
        )}
        {projects?.map((p) => (
          <DropdownMenuItem
            key={p.id}
            onSelect={() => navigate(target === 'annotate' ? `/p/${p.id}/annotate` : `/p/${p.id}`)}
            icon={p.id === project.id ? <Check className="!text-accent-text" /> : <span className="size-4" />}
          >
            <span className="flex items-center gap-2">
              <span className="truncate">{p.name}</span>
              <FormatBadge format={p.label_format} />
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<LayoutGrid />} onSelect={() => navigate('/')}>
          All projects
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
