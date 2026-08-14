import type { AutomationTriggerType } from '@/types'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'

// ------------------------------------------------------------
// Pre-flight config validation for automations about to be activated.
//
// Activating a broken automation (e.g. an add_tag step with tag_id="")
// used to succeed silently — every trigger then produced a failed log
// row with a cryptic "add_tag needs contact + tag_id" message, and
// users often didn't notice until reviewing logs. This module lets
// the API refuse activation with a useful 400 response instead.
//
// The rules here mirror the runtime checks in engine.ts's runStep;
// they're the same invariants, enforced one step earlier so failures
// surface at save time.
// ------------------------------------------------------------

export interface ValidationIssue {
  /** Dot-path for the UI to highlight; stable enough to build a table. */
  path: string
  message: string
}

interface StepLike {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: StepLike[]; no?: StepLike[] }
}

export function validateStepsForActivation(steps: StepLike[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({
      path: 'steps',
      message: 'active automations need at least one step',
    })
    return issues
  }
  walk(steps, '', issues)
  return issues
}

function walk(steps: StepLike[], prefix: string, issues: ValidationIssue[]): void {
  steps.forEach((s, i) => {
    const path = `${prefix}steps[${i}]`
    validateOne(s, path, issues)
    if (s.step_type === 'condition' && s.branches) {
      if (s.branches.yes) walk(s.branches.yes, `${path}.yes.`, issues)
      if (s.branches.no) walk(s.branches.no, `${path}.no.`, issues)
    }
  })
}

function validateOne(step: StepLike, path: string, issues: ValidationIssue[]): void {
  const c = step.step_config ?? {}
  switch (step.step_type) {
    case 'send_message':
      if (!nonEmpty(c.text)) {
        issues.push({ path: `${path}.text`, message: 'message text is required' })
      }
      break
    case 'send_buttons':
    case 'send_list': {
      // The whole step_config IS the interactive payload; validate it
      // against Meta's limits (same check the engine runs before send).
      const result = validateInteractivePayload(c)
      if (!result.ok) {
        issues.push({ path: `${path}.interactive`, message: result.error })
      }
      break
    }
    case 'send_template':
      if (!nonEmpty(c.template_name)) {
        issues.push({ path: `${path}.template_name`, message: 'template name is required' })
      }
      break
    case 'add_tag':
    case 'remove_tag':
      if (!nonEmpty(c.tag_id)) {
        issues.push({ path: `${path}.tag_id`, message: 'tag is required' })
      }
      break
    case 'assign_conversation':
      if (c.mode === 'specific' && !nonEmpty(c.agent_id)) {
        issues.push({
          path: `${path}.agent_id`,
          message: 'agent is required when mode is "specific"',
        })
      }
      break
    case 'update_contact_field':
      if (!nonEmpty(c.field)) {
        issues.push({ path: `${path}.field`, message: 'field name is required' })
      }
      if (c.value === undefined || c.value === null || c.value === '') {
        issues.push({ path: `${path}.value`, message: 'field value is required' })
      }
      break
    case 'create_deal':
      if (!nonEmpty(c.pipeline_id)) {
        issues.push({ path: `${path}.pipeline_id`, message: 'pipeline is required' })
      }
      if (!nonEmpty(c.stage_id)) {
        issues.push({ path: `${path}.stage_id`, message: 'stage is required' })
      }
      if (!nonEmpty(c.title)) {
        issues.push({ path: `${path}.title`, message: 'title is required' })
      }
      break
    case 'wait':
      if (typeof c.amount !== 'number' || !Number.isFinite(c.amount) || c.amount <= 0) {
        issues.push({ path: `${path}.amount`, message: 'wait amount must be greater than 0' })
      }
      if (!['minutes', 'hours', 'days'].includes(String(c.unit))) {
        issues.push({
          path: `${path}.unit`,
          message: 'wait unit must be minutes, hours, or days',
        })
      }
      break
    case 'condition':
      if (!nonEmpty(c.subject)) {
        issues.push({ path: `${path}.subject`, message: 'condition subject is required' })
      }
      if (!nonEmpty(c.operand)) {
        issues.push({ path: `${path}.operand`, message: 'condition operand is required' })
      }
      break
    case 'send_webhook':
      if (!nonEmpty(c.url)) {
        issues.push({ path: `${path}.url`, message: 'webhook URL is required' })
        break
      }
      try {
        const u = new URL(String(c.url))
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          issues.push({
            path: `${path}.url`,
            message: 'webhook URL must use http or https',
          })
        }
      } catch {
        issues.push({ path: `${path}.url`, message: 'webhook URL is not a valid URL' })
      }
      break
    case 'close_conversation':
      // No config required.
      break
    case 'notify': {
      // ⛔ Sem este caso o passo caia no `default` e a automacao NAO ligava:
      // "Cannot keep automation active with invalid configuration". Foi o que
      // travou as regras de 2h e 4h de "esperando resposta" (14/08/2026).
      if (!nonEmpty(c.titulo)) {
        issues.push({ path, message: 'notify precisa de um titulo' })
      }
      const dest = c.destinatario
      if (dest != null && dest !== 'atribuido' && dest !== 'todos' && dest !== 'usuario') {
        issues.push({
          path,
          message: 'destinatario deve ser "atribuido", "todos" ou "usuario"',
        })
      }
      if (dest === 'usuario' && !nonEmpty(c.user_id)) {
        issues.push({ path, message: 'destinatario "usuario" precisa de user_id' })
      }
      break
    }
    default:
      issues.push({ path, message: `unknown step type: ${step.step_type}` })
  }
}

export function validateTriggerForActivation(
  triggerType: AutomationTriggerType | string,
  triggerConfig: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const cfg = (triggerConfig ?? {}) as Record<string, unknown>

  if (triggerType === 'keyword_match') {
    const k = cfg.keywords
    if (!Array.isArray(k) || k.length === 0) {
      issues.push({ path: 'trigger.keywords', message: 'at least one keyword is required' })
    } else if (k.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({ path: 'trigger.keywords', message: 'keywords cannot be empty strings' })
    }
    // A missing match_type defaults to "contains" at runtime (see
    // automations/engine.ts and flows/engine.ts, which both read
    // `match_type ?? "contains"`), so only an explicit, unrecognised
    // value is invalid here. This keeps activation validation in step
    // with the engine and with the builder's "Contains" default — an
    // automation that shows the default in the UI must not be rejected.
    if (cfg.match_type != null && cfg.match_type !== 'exact' && cfg.match_type !== 'contains') {
      issues.push({
        path: 'trigger.match_type',
        message: 'match type must be "exact" or "contains"',
      })
    }
  } else if (triggerType === 'time_based') {
    // ⛔ O motor aceita DOIS eixos (tempo.ts): horario fixo (`schedule`) OU
    // disparo relativo a uma data do contato (`relativo`), e os dois podem se
    // somar. Exigir `schedule` sempre barrava automacao que o motor executa
    // sem problema — foi o que impediu as FUP de serem ligadas (14/08/2026).
    // O cabecalho deste arquivo diz que as regras aqui espelham o engine;
    // esta nao espelhava.
    const rel = cfg.relativo as { horas_antes?: unknown } | undefined
    const temRelativo = !!rel && typeof rel === 'object' && rel.horas_antes != null
    if (!nonEmpty(cfg.schedule) && !temRelativo) {
      issues.push({
        path: 'trigger.schedule',
        message: 'informe um horario (schedule) ou um disparo relativo a uma data',
      })
    }
  } else if (triggerType === 'tag_added') {
    if (!nonEmpty(cfg.tag_id)) {
      issues.push({ path: 'trigger.tag_id', message: 'tag is required' })
    }
  } else if (triggerType === 'deal_stage_changed') {
    if (!nonEmpty(cfg.stage_id)) {
      issues.push({ path: 'trigger.stage_id', message: 'stage is required' })
    }
  } else if (triggerType === 'awaiting_reply') {
    // Sem config obrigatoria: `horas_uteis` ausente = 0 = avisa na hora.
    // So um valor explicitamente invalido e recusado.
    const h = cfg.horas_uteis
    if (h != null && (typeof h !== 'number' || !Number.isFinite(h) || h < 0)) {
      issues.push({
        path: 'trigger.horas_uteis',
        message: 'horas de espera deve ser um numero maior ou igual a zero',
      })
    }
  } else if (triggerType === 'interactive_reply') {
    const ids = cfg.reply_ids
    if (!Array.isArray(ids) || ids.length === 0) {
      issues.push({
        path: 'trigger.reply_ids',
        message: 'at least one reply id is required',
      })
    } else if (ids.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({
        path: 'trigger.reply_ids',
        message: 'reply ids cannot be empty strings',
      })
    }
  }

  return issues
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}
