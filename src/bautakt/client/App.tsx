import { useEffect, type ReactNode } from 'react'
import { matchRoute, navigate, useRoute } from './lib/router'
import { useAuth } from './store/auth'
import { OrgProvider } from './store/org'
import { ProjectProvider, useProject } from './store/project'
import { AppShell } from './components/AppShell'
import { Spinner } from './components/ui'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { ProjectWizardPage } from './pages/ProjectWizardPage'
import { ProjectOverviewPage } from './pages/ProjectOverviewPage'
import { GanttPage } from './pages/GanttPage'
import { TasksPage } from './pages/TasksPage'
import { LookaheadPage } from './pages/LookaheadPage'
import { MilestonesPage } from './pages/MilestonesPage'
import { BaselinePage } from './pages/BaselinePage'
import { ScenariosPage } from './pages/ScenariosPage'
import { ReportsPage } from './pages/ReportsPage'
import { HistoryPage } from './pages/HistoryPage'
import { ProjectSettingsPage } from './pages/ProjectSettingsPage'
import { PortfolioPage } from './pages/PortfolioPage'
import { SitePage } from './pages/SitePage'
import { ResourcesPage } from './pages/ResourcesPage'
import { CalendarPage } from './pages/CalendarPage'
import { TemplatesPage } from './pages/TemplatesPage'
import { TeamPage } from './pages/TeamPage'
import { SettingsPage } from './pages/SettingsPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { OrgLookaheadPage } from './pages/OrgLookaheadPage'
import { OrgMilestonesPage } from './pages/OrgMilestonesPage'
import { OrgReportsPage } from './pages/OrgReportsPage'
import { TradesPage } from './pages/TradesPage'
import { ProposalsPage } from './pages/ProposalsPage'
import { SharePage } from './pages/SharePage'
import { SchedulePickerPage } from './pages/SchedulePickerPage'
import { InboxPage } from './pages/InboxPage'

const PROJECT_PAGES: Record<string, (p: { id: string }) => ReactNode> = {
  '': () => <ProjectOverviewPage />,
  gantt: () => <GanttPage />,
  tasks: () => <TasksPage />,
  lookahead: () => <LookaheadPage />,
  milestones: () => <MilestonesPage />,
  baseline: () => <BaselinePage />,
  scenarios: () => <ScenariosPage />,
  reports: () => <ReportsPage />,
  history: () => <HistoryPage />,
  settings: () => <ProjectSettingsPage />,
  trades: () => <TradesPage />,
  proposals: () => <ProposalsPage />,
}

export function App() {
  const { session, loading } = useAuth()
  const { path } = useRoute()
  const share = matchRoute('/share/:token', path)

  useEffect(() => {
    if (share) return
    if (!loading && !session && path !== '/login') navigate('/login', { replace: true })
    if (session && path === '/login') navigate('/', { replace: true })
  }, [session, loading, path, share])

  // Öffentlicher Gewerkeplan (Token) - ohne Anmeldung, ohne Shell
  if (share) return <SharePage token={share.token} />
  if (loading) return <Spinner label="Anmeldung wird geprüft …" />
  if (!session) return <LoginPage />

  return (
    <OrgProvider>
      <Routes path={path} />
    </OrgProvider>
  )
}

function Routes({ path }: { path: string }) {
  const project = matchRoute('/projects/:id', path) ?? matchRoute('/projects/:id/:sub', path)
  if (project && project.id !== 'new') {
    const sub = project.sub ?? ''
    const render = PROJECT_PAGES[sub]
    return (
      <ProjectProvider projectId={project.id}>
        <ProjectShell>{render ? render({ id: project.id }) : <NotFound />}</ProjectShell>
      </ProjectProvider>
    )
  }
  // Baustellenansicht: bewusst ohne Sidebar (Smartphone, große Bedienelemente)
  if (path === '/site' || path.startsWith('/site/')) return <SitePage />

  let page: ReactNode
  switch (path) {
    case '/':
      page = <DashboardPage />
      break
    case '/projects':
      page = <ProjectsPage />
      break
    case '/projects/new':
      page = <ProjectWizardPage />
      break
    case '/portfolio':
      page = <PortfolioPage />
      break
    case '/schedule':
      page = <SchedulePickerPage />
      break
    case '/lookahead':
      page = <OrgLookaheadPage />
      break
    case '/milestones':
      page = <OrgMilestonesPage />
      break
    case '/resources':
      page = <ResourcesPage />
      break
    case '/calendar':
      page = <CalendarPage />
      break
    case '/templates':
      page = <TemplatesPage />
      break
    case '/reports':
      page = <OrgReportsPage />
      break
    case '/team':
      page = <TeamPage />
      break
    case '/settings':
      page = <SettingsPage />
      break
    case '/notifications':
      page = <NotificationsPage />
      break
    case '/inbox':
      page = <InboxPage />
      break
    default:
      page = <NotFound />
  }
  return <AppShell>{page}</AppShell>
}

function ProjectShell({ children }: { children: ReactNode }) {
  const { bundle } = useProject()
  return <AppShell projectName={bundle?.project.name} planningKind={bundle?.project.planning_kind}>{children}</AppShell>
}

function NotFound() {
  return (
    <div className="p-10 text-center text-sm text-ink-soft">
      Seite nicht gefunden.{' '}
      <a href="/" className="text-brand hover:underline">
        Zum Dashboard
      </a>
    </div>
  )
}
