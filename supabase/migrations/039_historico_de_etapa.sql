-- ============================================================
-- 039 — Quando o card entrou na etapa, e por onde ele passou
--
-- O radar precisa responder "quem mudou de etapa HOJE" e "há quanto
-- tempo este card está parado". O CRM não guardava nem uma coisa nem
-- outra: `deals.updated_at` muda por qualquer edição — mudar o título
-- zerava a conta de dias parado.
--
-- POR QUE UM GATILHO DE BANCO, E NÃO CÓDIGO
-- Card muda de etapa em quatro lugares diferentes: arrastando no
-- quadro, pelo formulário do card, pela automação (`move_deal`), pela
-- IA e pelo `intake.js` que roda na VPS. Registrar em cada um seria
-- esquecer um — e o esquecido só apareceria quando alguém percebesse
-- um número errado no relatório, meses depois. O gatilho pega todos,
-- inclusive os que ainda não existem.
--
-- Idempotente — seguro rodar mais de uma vez.
-- ============================================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS stage_entered_at TIMESTAMPTZ;

-- Retroativo: para os cards que já existem não há como saber a data
-- real de entrada, então usa-se `updated_at` como aproximação. É uma
-- estimativa, e está dito aqui para ninguém tratar como fato.
UPDATE deals SET stage_entered_at = updated_at WHERE stage_entered_at IS NULL;

ALTER TABLE deals
  ALTER COLUMN stage_entered_at SET DEFAULT now();

CREATE TABLE IF NOT EXISTS deal_stage_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id       UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL,
  from_stage_id UUID,
  to_stage_id   UUID NOT NULL,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- "user" quando veio de sessão autenticada; "automation" quando veio
  -- do service-role (motor, IA, intake). É o que o radar usa para
  -- separar movimento humano de movimento de máquina.
  changed_by    TEXT NOT NULL DEFAULT 'automation'
);

CREATE INDEX IF NOT EXISTS deal_stage_history_deal_idx
  ON deal_stage_history (deal_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS deal_stage_history_dia_idx
  ON deal_stage_history (account_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS deals_stage_entered_idx
  ON deals (account_id, stage_entered_at DESC);

CREATE OR REPLACE FUNCTION registrar_mudanca_de_etapa()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    NEW.stage_entered_at := now();

    INSERT INTO deal_stage_history (deal_id, account_id, from_stage_id, to_stage_id, changed_by)
    VALUES (
      NEW.id,
      NEW.account_id,
      OLD.stage_id,
      NEW.stage_id,
      -- auth.uid() só existe quando a chamada veio de uma sessão de
      -- usuário; o service-role (motor, IA, intake) não tem.
      CASE WHEN auth.uid() IS NULL THEN 'automation' ELSE 'user' END
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS deals_registra_etapa ON deals;
CREATE TRIGGER deals_registra_etapa
  BEFORE UPDATE ON deals
  FOR EACH ROW
  EXECUTE FUNCTION registrar_mudanca_de_etapa();

ALTER TABLE deal_stage_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_stage_history_select ON deal_stage_history;
CREATE POLICY deal_stage_history_select ON deal_stage_history
  FOR SELECT USING (is_account_member(account_id));

COMMENT ON COLUMN deals.stage_entered_at IS
  'Quando o card entrou na etapa atual. Mantido pelo gatilho deals_registra_etapa; para cards anteriores a 10/08/2026 é uma estimativa (updated_at).';
COMMENT ON TABLE deal_stage_history IS
  'Uma linha por mudança de etapa. Alimentada por gatilho, então cobre quadro, formulário, automação, IA e os scripts da VPS.';
