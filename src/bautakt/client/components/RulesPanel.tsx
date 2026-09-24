/**
 * Baulogische Regeln (Rule/Constraint Engine): Systemregeln ansehen und je Organisation
 * bzw. Projekt anpassen/deaktivieren, eigene Regeln anlegen. Regeln sind Grenzen – für die
 * Planprüfung heute und für die KI-Optimierung in Szenarien später.
 */

import { useEffect, useState } from 'react'
import { Plus, Trash2, ShieldCheck, Pencil } from 'lucide-react'
import { api } from '../lib/api'
import { useOrg } from '../store/org'
import { useAuth } from '../store/auth'
import { useToast } from '../store/toast'
import { Badge, Button, Card, Checkbox, Field, IconButton, Input, Modal, Select, Spinner } from './ui'
import { RULE_KIND_LABELS, scopeOf, type PlanRule, type RuleKind, type RuleSeverity } from '../../shared/rules/engine'

const SCOPE_LABEL = { system: 'System', org: 'Organisation', project: 'Projekt', template: 'Vorlage' }
const SEV_TONE: Record<RuleSeverity, 'neutral' | 'warn' | 'danger'> = { info: 'neutral', warning: 'warn', critical: 'danger' }
const SEV_LABEL: Record<RuleSeverity, string> = { info: 'Hinweis', warning: 'Warnung', critical: 'Kritisch' }

type Form = { id?: string; overrides_system_id?: string; kind: RuleKind; name: string; trade_a: string; trade_b: string; min_days: number; pattern_a: string; pattern_b: string; same_section: boolean; severity: RuleSeverity; enabled: boolean; project_id: string | null }

export function RulesPanel({ projectId = null }: { projectId?: string | null }) {
  const org = useOrg()
  const { can } = useAuth()
  const toast = useToast()
  const [data, setData] = useState<{ system: PlanRule[]; custom: PlanRule[]; effective: PlanRule[] } | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const ro = !can('rules.manage')
  const load = () => api.rules.list(projectId ?? undefined).then(setData).catch((e) => toast.push(e.message, 'error'))
  useEffect(() => {
    void load()
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <Spinner />

  const describe = (r: PlanRule) => {
    const c = r.config
    const b = c.trade_b ?? (c.pattern_b ? `„${c.pattern_b}“` : 'jeder Nachfolger')
    if (r.kind === 'required_order') return `${b} erst nach Abschluss von ${c.trade_a}${c.same_section !== false ? ' (gleicher Abschnitt)' : ''}`
    if (r.kind === 'min_gap') return `mindestens ${c.min_days ?? 0} Kalendertage zwischen Ende ${c.trade_a} und Start ${b}`
    return `${c.trade_a} und ${b} nicht gleichzeitig${c.same_section !== false ? ' im selben Abschnitt' : ''}`
  }
  const save = async () => {
    if (!form) return
    try {
      const config = { trade_a: form.trade_a, trade_b: form.trade_b || null, min_days: form.kind === 'min_gap' ? form.min_days : undefined, pattern_a: form.pattern_a || undefined, pattern_b: form.pattern_b || undefined, same_section: form.same_section }
      if (form.id) await api.rules.update(form.id, { kind: form.kind, name: form.name, config, severity: form.severity, enabled: form.enabled })
      else await api.rules.create({ kind: form.kind, name: form.name, config, severity: form.severity, enabled: form.enabled, project_id: form.project_id, overrides_system_id: form.overrides_system_id })
      setForm(null)
      await load()
      toast.push('Regel gespeichert.', 'success')
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const toggle = async (r: PlanRule) => {
    try {
      if (scopeOf(r) === 'system') {
        // Systemregel deaktivieren/aktivieren = Org-/Projekt-Override anlegen
        const existing = data.custom.find((c) => c.id === `${r.id}@${projectId ?? org.org.id}`)
        if (existing) await api.rules.update(existing.id, { enabled: !existing.enabled })
        else await api.rules.create({ kind: r.kind, name: r.name, config: r.config, severity: r.severity, enabled: false, project_id: projectId, overrides_system_id: r.id })
      } else await api.rules.update(r.id, { enabled: !r.enabled })
      await load()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }
  const editRule = (r: PlanRule) => setForm({ id: scopeOf(r) === 'system' ? undefined : r.id, overrides_system_id: scopeOf(r) === 'system' ? r.id : undefined, kind: r.kind, name: r.name, trade_a: r.config.trade_a, trade_b: r.config.trade_b ?? '', min_days: r.config.min_days ?? 0, pattern_a: r.config.pattern_a ?? '', pattern_b: r.config.pattern_b ?? '', same_section: r.config.same_section !== false, severity: r.severity, enabled: r.enabled, project_id: projectId })
  const remove = async (r: PlanRule) => {
    if (!confirm('Regel löschen?')) return
    await api.rules.remove(r.id)
    await load()
  }
  const isOverridden = (r: PlanRule) => data.custom.some((c) => c.id.startsWith(r.id + '@'))

  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-2"><ShieldCheck size={15} /> Baulogische Regeln{projectId ? ' (wirksam in diesem Projekt)' : ''}</span>} padded={false} actions={!ro && <Button size="sm" variant="primary" onClick={() => setForm({ kind: 'min_gap', name: '', trade_a: '', trade_b: '', min_days: 7, pattern_a: '', pattern_b: '', same_section: true, severity: 'warning', enabled: true, project_id: projectId })}><Plus size={14} /> Regel</Button>}>
        <p className="border-b border-line px-4 py-3 text-sm text-ink-soft">Regeln beschreiben, was baulogisch nicht zulässig ist (z. B. Fliesen vor Belegreife des Estrichs). Die Planprüfung meldet Verstöße, Vorschläge und Szenarien weisen neue Verstöße aus – und eine spätere KI darf nur innerhalb dieser Grenzen optimieren. Systemregeln lassen sich je Organisation oder Projekt deaktivieren oder anpassen.</p>
        <table className="data-table w-full text-sm">
          <thead><tr><th>Regel</th><th>Art</th><th>Bedeutung</th><th>Ebene</th><th>Schwere</th><th>Aktiv</th><th /></tr></thead>
          <tbody>
            {data.effective.map((r) => {
              const scope = scopeOf(r)
              const sysOverridden = scope === 'system' && isOverridden(r)
              return (
                <tr key={r.id} className={!r.enabled ? 'opacity-60' : ''}>
                  <td className="font-medium">{r.name}</td>
                  <td className="text-xs">{RULE_KIND_LABELS[r.kind]}</td>
                  <td className="text-xs text-ink-soft">{describe(r)}</td>
                  <td className="text-xs"><Badge tone="neutral">{SCOPE_LABEL[scope]}{sysOverridden ? ' · angepasst' : ''}</Badge></td>
                  <td><Badge tone={SEV_TONE[r.severity]}>{SEV_LABEL[r.severity]}</Badge></td>
                  <td>{ro ? (r.enabled ? 'ja' : 'nein') : <Checkbox label="" checked={r.enabled} onChange={() => toggle(r)} />}</td>
                  <td className="text-right whitespace-nowrap">{!ro && <><IconButton title={scope === 'system' ? 'Anpassen (als eigene Regel überschreiben)' : 'Bearbeiten'} onClick={() => editRule(r)}><Pencil size={14} /></IconButton>{scope !== 'system' && <IconButton title="Löschen" onClick={() => remove(r)}><Trash2 size={14} /></IconButton>}</>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Regel bearbeiten' : form?.overrides_system_id ? 'Systemregel anpassen' : 'Neue Regel'} width="md" footer={<><Button variant="ghost" onClick={() => setForm(null)}>Abbrechen</Button><Button variant="primary" disabled={!form?.name || (!form?.trade_a && !form?.pattern_a)} onClick={save}>Speichern</Button></>}>
        {form && (
          <div className="space-y-3">
            <Field label="Name" required><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Art"><Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as RuleKind })}>{(Object.keys(RULE_KIND_LABELS) as RuleKind[]).map((k) => <option key={k} value={k}>{RULE_KIND_LABELS[k]}</option>)}</Select></Field>
              <Field label="Schwere"><Select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as RuleSeverity })}>{(['info', 'warning', 'critical'] as RuleSeverity[]).map((s) => <option key={s} value={s}>{SEV_LABEL[s]}</option>)}</Select></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Gewerk A (Vorleistung)" required><Input list="rule-trades" value={form.trade_a} onChange={(e) => setForm({ ...form, trade_a: e.target.value })} placeholder="z. B. Estrich" /></Field>
              <Field label="Gewerk B (Folgeleistung)" hint={form.kind === 'min_gap' ? 'leer = jeder direkte Nachfolger' : undefined}><Input list="rule-trades" value={form.trade_b} onChange={(e) => setForm({ ...form, trade_b: e.target.value })} placeholder="z. B. Fliesen" /></Field>
            </div>
            <datalist id="rule-trades">{org.trades.map((t) => <option key={t.id} value={t.name} />)}</datalist>
            {form.kind === 'min_gap' && <Field label="Mindestabstand (Kalendertage)"><Input type="number" min={0} value={form.min_days} onChange={(e) => setForm({ ...form, min_days: Number(e.target.value) })} /></Field>}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Namensmuster A (optional, Regex)" hint="greift bei Vorgängen ohne Gewerk"><Input value={form.pattern_a} onChange={(e) => setForm({ ...form, pattern_a: e.target.value })} placeholder="estrich" /></Field>
              <Field label="Namensmuster B (optional, Regex)"><Input value={form.pattern_b} onChange={(e) => setForm({ ...form, pattern_b: e.target.value })} placeholder="fliesen" /></Field>
            </div>
            <Checkbox label="Nur innerhalb desselben Bauabschnitts prüfen" checked={form.same_section} onChange={(e) => setForm({ ...form, same_section: e.target.checked })} />
            <Checkbox label="Aktiv" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            <p className="text-xs text-ink-faint">Gilt für: {form.project_id ? 'dieses Projekt' : 'die gesamte Organisation'}{form.overrides_system_id ? ' (überschreibt die Systemregel)' : ''}.</p>
          </div>
        )}
      </Modal>
    </div>
  )
}
