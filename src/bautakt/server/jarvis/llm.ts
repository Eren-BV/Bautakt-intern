/**
 * Ein Modellaufruf der Jarvis-Schleife (Responses API mit Function Calling, gestreamt).
 * Textbausteine werden sofort weitergereicht (für Anzeige und Sprachausgabe), die vollständigen
 * Ausgabe-Items (Text, Funktionsaufrufe, Reasoning) werden für den nächsten Schritt gesammelt.
 */

import { HttpError } from '../auth.ts'
import { aiPost, modelId, readSse, type AiProvider } from '../services/aiGateway.ts'

export const JARVIS_MODEL = process.env['JARVIS_MODEL'] || 'openai/gpt-6-astra'
const JARVIS_EFFORT = process.env['JARVIS_EFFORT'] || 'low'

export type OutputItem = Record<string, unknown> & { type: string }

export interface ModelUsage {
  input: number
  cached: number
  output: number
}

export interface ModelResult {
  output: OutputItem[]
  text: string
  usage: ModelUsage
}

// Lehnt ein Anbieter verschlüsselte Reasoning-Inhalte ab, merken wir uns das pro Isolate.
let includeReasoning = true

export async function runModel(opts: {
  provider: AiProvider
  instructions: string
  tools: object[]
  input: unknown[]
  onText: (delta: string) => void
  signal?: AbortSignal
}): Promise<ModelResult> {
  const body = (withReasoning: boolean) => ({
    model: modelId(opts.provider, JARVIS_MODEL),
    instructions: opts.instructions,
    tools: opts.tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    input: withReasoning ? opts.input : opts.input.filter((i) => (i as { type?: string }).type !== 'reasoning'),
    reasoning: { effort: JARVIS_EFFORT },
    ...(withReasoning ? { include: ['reasoning.encrypted_content'] } : {}),
    store: false,
    stream: true,
    // Knapp halten: kürzere Antworten sind schneller fertig UND schneller gesprochen.
    // 'low' ist bei diesem Modell bereits die schnellste verfügbare Stufe (kein 'minimal').
    max_output_tokens: 500,
  })

  let res: Response
  try {
    res = await aiPost('/responses', body(includeReasoning), { provider: opts.provider, signal: opts.signal })
  } catch (e) {
    if (includeReasoning && e instanceof HttpError && e.status === 502 && /encrypted_content|reasoning|include/i.test(e.message)) {
      includeReasoning = false
      res = await aiPost('/responses', body(false), { provider: opts.provider, signal: opts.signal })
    } else throw e
  }

  const output: OutputItem[] = []
  let text = ''
  let usage: ModelUsage = { input: 0, cached: 0, output: 0 }
  for await (const ev of readSse(res)) {
    switch (ev.type) {
      case 'response.output_text.delta':
        if (typeof ev.delta === 'string') {
          text += ev.delta
          opts.onText(ev.delta)
        }
        break
      case 'response.output_item.done':
        if (ev.item && typeof ev.item === 'object') output.push(ev.item as OutputItem)
        break
      case 'response.completed':
      case 'response.incomplete': {
        const r = ev.response as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }; output?: OutputItem[] } | undefined
        usage = { input: r?.usage?.input_tokens ?? 0, cached: r?.usage?.input_tokens_details?.cached_tokens ?? 0, output: r?.usage?.output_tokens ?? 0 }
        if (!output.length && Array.isArray(r?.output)) output.push(...r!.output)
        break
      }
      case 'response.failed':
      case 'error': {
        const msg = (ev.response as { error?: { message?: string } } | undefined)?.error?.message ?? (ev as { message?: string }).message ?? 'unbekannter Fehler'
        throw new HttpError(502, `KI-Antwort fehlgeschlagen: ${msg}`)
      }
    }
  }
  return { output, text, usage }
}
