-- ============================================================
-- 040 — NOTIFICAÇÃO DE CONVERSA AGUARDANDO RESPOSTA
-- ============================================================
-- A tabela `notifications` (027) nasceu com um único tipo,
-- 'conversation_assigned', e nada além do gatilho de atribuição
-- escrevia nela — por isso a tela de Notificação parecia inútil.
-- Aqui ela ganha o segundo tipo, escrito pelo passo `notify` do
-- motor de automação.
--
-- ⛔ O CHECK é a única coisa que precisa de migração: `trigger_type`
-- e `step_type` das automações são TEXT livre (006), então o gatilho
-- `awaiting_reply` e o passo `notify` não exigem alteração de schema.

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'awaiting_reply'));

-- O passo `notify` insere com a service role (SECURITY DEFINER-like),
-- então não há política nova de INSERT para o cliente: continua valendo
-- a regra de 027 — quem lê é o destinatário, e só `read_at` é gravável.

COMMENT ON COLUMN notifications.type IS
  'conversation_assigned: gatilho de atribuição (027). '
  'awaiting_reply: conversa parada esperando resposta humana, escrita '
  'pelo passo notify do motor de automação (040).';
