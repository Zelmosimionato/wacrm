-- ============================================================
-- 044 — NOTIFICAÇÃO DE PJ BLOQUEADO NO [[AGENDAR]]
-- ============================================================
-- Quarto `type` em `notifications` (027 → conversation_assigned;
-- 040 → awaiting_reply; 043 → urgent_lead). Escrito por
-- `notificarPjAgendamentoBloqueado` em auto-reply.ts quando o [[AGENDAR]]
-- é bloqueado por o contato ser PJ (fora do rollout faseado do Fluxo de
-- Agendamento — só PF nesta fase). Sem isto, o texto enviado ao cliente
-- ("vou repassar para a equipe entrar em contato") prometia um contato
-- humano que nada no código de fato acionava (achado C4/I4 da revisão
-- independente de 20/08/2026 sobre o commit 599f358).
-- ============================================================

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'awaiting_reply', 'urgent_lead', 'pj_agendamento_bloqueado'));

COMMENT ON COLUMN notifications.type IS
  'conversation_assigned: gatilho de atribuição (027). '
  'awaiting_reply: conversa parada esperando resposta humana (040). '
  'urgent_lead: tag Urgente aplicada pela IA — handoff imediato, sem checar prazo (043). '
  'pj_agendamento_bloqueado: [[AGENDAR]] bloqueado por o lead ser PJ, fora do rollout faseado (044).';
