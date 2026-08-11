-- ============================================================
-- 038 — Por qual número cada mensagem passou
--
-- Passam a existir dois números: o oficial (API da Meta, que só abre
-- conversa por template aprovado) e o segundo (WhatsApp Web, texto
-- livre, para o toque curto — "sua reunião começa em cinco minutos").
--
-- A conversa continua sendo UMA, a da pessoa. Dois fios para o mesmo
-- lead seria confusão na tela e obrigaria a escolher qual abrir. O que
-- muda de mensagem para mensagem é por onde ela passou — e é isso que
-- a coluna guarda.
--
-- Serve a duas coisas concretas: mostrar na bolha por qual número
-- aquilo saiu ou chegou, e decidir a resposta — quem escreveu pelo
-- segundo número não tem janela de 24h aberta no oficial, então
-- responder pelo canal errado falha ou sai por um número que a pessoa
-- não conhece.
--
-- Tudo que existe hoje veio do número oficial, por isso o padrão é
-- 'api' — nenhuma linha existente muda de significado.
--
-- Idempotente — seguro rodar mais de uma vez.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'api';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_channel_check'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_channel_check
      CHECK (channel IN ('api', 'web'));
  END IF;
END $$;

COMMENT ON COLUMN messages.channel IS
  'api = número oficial (Cloud API da Meta); web = segundo número (WhatsApp Web, não oficial)';

-- Por onde a conversa foi atendida da última vez. É só a memória do
-- seletor: ao reabrir o fio, o campo de escrita já vem no canal em que
-- se estava falando, em vez de voltar sempre ao oficial e mandar pelo
-- número errado por distração.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_channel TEXT NOT NULL DEFAULT 'api';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_last_channel_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_last_channel_check
      CHECK (last_channel IN ('api', 'web'));
  END IF;
END $$;

COMMENT ON COLUMN conversations.last_channel IS
  'Último canal usado nesta conversa — memória do seletor, não classificação da conversa';
