import { GanttWorkspace } from '../components/gantt/GanttWorkspace'
import { ProjectHeader } from '../components/ProjectHeader'

export function GanttPage() {
  return (
    <div className="flex h-[calc(100vh-56px)] flex-col">
      <ProjectHeader compact title="Terminplan" />
      <div className="min-h-0 flex-1">
        <GanttWorkspace />
      </div>
    </div>
  )
}
