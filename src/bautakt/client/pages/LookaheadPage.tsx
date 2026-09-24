import { useProject } from '../store/project'
import { ProjectHeader } from '../components/ProjectHeader'
import { LookaheadView } from '../components/LookaheadView'
import { Spinner } from '../components/ui'

export function LookaheadPage() {
  const p = useProject()
  if (!p.bundle || !p.analysis) return <Spinner />
  return (
    <div>
      <ProjectHeader title="Lookahead" />
      <div className="mx-auto max-w-[1440px] p-4 sm:p-6">
        <LookaheadView title={p.bundle.project.name} sources={[{ project: p.bundle.project, tasks: p.plan.tasks, dependencies: p.plan.dependencies, constraints: p.bundle.constraints, sections: p.bundle.sections, sched: p.analysis.current }]} />
      </div>
    </div>
  )
}
