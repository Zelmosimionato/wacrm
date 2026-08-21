-- ============================================================
-- 043 — NOTIFICAÇÃO DE LEAD URGENTE
-- ============================================================
-- Terceiro `type` em `notifications` (027 → conversation_assigned;
-- 040 → awaiting_reply). Escrito por `applyAiUrgente` em auto-reply.ts
-- quando a tag "Urgente" é aplicada — handoff imediato, sem esperar
-- checagem de prazo de agenda (ver spec agendamento-fluxos-design.md,
-- seção "Sinal de urgência").
-- ============================================================

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'awaiting_reply', 'urgent_lead'));

COMMENT ON COLUMN notifications.type IS
  'conversation_assigned: gatilho de atribuição (027). '
  'awaiting_reply: conversa parada esperando resposta humana (040). '
  'urgent_lead: tag Urgente aplicada pela IA — handoff imediato, sem checar prazo (043).';
