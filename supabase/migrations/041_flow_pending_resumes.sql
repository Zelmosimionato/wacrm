-- ============================================================
-- flow_pending_resumes — fila de retomada por tempo pro motor de Fluxos.
--
-- Espelha o papel de automation_pending_executions, mas pro motor de
-- Fluxos: o alvo da retomada é current_node_key (string, num grafo),
-- não next_step_position (número, numa lista linear) — por isso é
-- tabela própria, não reaproveitamento.
-- ============================================================

CREATE TABLE flow_pending_resumes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  node_key TEXT NOT NULL,
  run_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'cancelled', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_flow_pending_resumes_due
  ON flow_pending_resumes (run_at)
  WHERE status = 'pending';

CREATE INDEX idx_flow_pending_resumes_run
  ON flow_pending_resumes (flow_run_id);

ALTER TABLE flow_pending_resumes ENABLE ROW LEVEL SECURITY;
-- No SELECT/INSERT/UPDATE/DELETE policy for authenticated users — all
-- access is server-side via the service-role key (same convention as
-- automation_pending_executions, migration 006).
