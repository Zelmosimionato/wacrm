-- 20/09/2026: quando o lead escolhe um horário mas ainda não deu o e-mail
-- (ou vice-versa), a IA às vezes "esquece" a escolha entre turnos e volta a
-- perguntar "qual horário você prefere?" mesmo já tendo a resposta — achado
-- real (caso Douglas Santos, conversa ec6ed411). Mesmo padrão já usado pra
-- valor/segmento (achado 01/09): grava o INSTANTE em que a informação
-- aparece, o sistema nunca depende da IA lembrar depois.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS horario_escolhido_iso timestamptz;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS horario_escolhido_rotulo text;

COMMENT ON COLUMN conversations.horario_escolhido_iso IS
  'ISO do horário do Cal.com que o lead escolheu (marcador [[HORARIO_ESCOLHIDO:N]]), gravado no turno em que ele escolhe — mesmo que falte e-mail ainda. Limpo depois que a reunião é criada ou quando o lead desiste.';

COMMENT ON COLUMN conversations.horario_escolhido_rotulo IS
  'Rótulo em português do horário escolhido ("dia 21, segunda-feira, às 16:45"), guardado junto pra não precisar reformatar o ISO depois.';
