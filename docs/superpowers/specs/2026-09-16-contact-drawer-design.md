# Card único de contato/negócio (ContactDrawer) — Design

Data: 2026-09-16
Pedido do titular: um card único e completo, disponível em todas as telas onde hoje um
card/contato aparece (Inbox, Funil, Contatos), com edição inline (tag, etapa, notas, campos
personalizados) sem precisar navegar pra outra aba.

## Contexto — o que já existe

Três telas mostram informação de contato/negócio hoje, cada uma com um subconjunto diferente,
editável de formas diferentes:

- **`contact-detail-view.tsx`** (`/contacts`) — a mais completa: 5 abas (Detalhes, Etiquetas,
  Notas, Campos personalizados, Negócios), todas editáveis. Etiquetas já são clicáveis pra
  alternar. Renderizada INLINE ao lado da lista (`/contacts` não tem rota `[id]`).
- **`contact-sidebar.tsx`** (Inbox, painel lateral da conversa) — mostra tags (só leitura),
  negócios (clicável, abre `DealForm`), notas (adicionável inline). Busca tudo via
  `fetchContactData` (3 queries em paralelo) sempre que o contato muda.
- **`deal-card.tsx`** + **`pipeline-board.tsx`** (Funil/Kanban) — só mostra dados do negócio
  (título, contato, valor, etapa por cor, responsável). Não mostra tags nem notas. Clique abre
  `DealForm`.

**`DealForm`** (`src/components/pipelines/deal-form.tsx`, 557 linhas) é o componente que já abre
como `Sheet` (gaveta lateral) a partir de qualquer uma dessas 3 telas pra editar um negócio
(inclui dropdown de etapa). Não cobre tags nem notas.

**Bug real achado durante o design** (relatado pelo titular, confirmado no código): em
`contact-sidebar.tsx`, o botão "Criar negócio" aparece **sempre** depois da lista de negócios,
mesmo quando o contato já tem um ou mais negócios — devia aparecer só quando a lista está vazia.

**Achado técnico relevante:** o projeto não tem SWR, react-query, nem nenhuma camada de cache —
toda busca é `supabase.from(...).select()` direto dentro de `useEffect`/`useCallback`, refeita a
cada vez que o componente monta. Isso é importante pro desenho de dados abaixo.

## Decisão de escopo (confirmada com o titular)

- Só essas 3 telas: Inbox, Contatos, Funil. Nenhuma outra tela do CRM entra nisso agora.
- A gaveta abre como painel lateral (`Sheet`), não como expansão inline no lugar do card — o
  Funil (Kanban/drag-and-drop) não pode ter cards expandindo na própria coluna, empurraria os
  outros cards e atrapalharia o arrastar.
- A gaveta tem as 5 seções que `contact-detail-view.tsx` já tem hoje: Detalhes, Etiquetas,
  Negócios, Notas, Campos personalizados — "tudo que for possível" (palavras do titular).
- A tela Contatos TAMBÉM passa a abrir essa gaveta (em vez do painel inline de hoje) — as 3
  telas usam exatamente o mesmo componente, sem exceção.
- **Regra de busca, explícita do titular:** a gaveta NÃO pode gerar busca nova toda vez que
  abre. "Hoje todas as informações já estão em algum card... o que basta é reunir tudo num
  único." Ou seja: reusar o que a tela que abriu a gaveta já buscou; só buscar o que
  genuinamente falta (ex.: campos personalizados, que hoje não é carregado nem no Inbox nem no
  Funil). Nada de biblioteca de cache nova — só passar o dado já carregado como prop em vez de
  a gaveta buscar de novo sozinha.

## Arquitetura

### Componente novo: `ContactDrawer`
`src/components/shared/contact-drawer.tsx` (pasta nova `shared/` — é usado pelas 3 telas, não
pertence a nenhuma delas).

```
interface ContactDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  // Dados que a tela que abriu JÁ tinha — evita busca duplicada. Cada um é
  // opcional; o que vier undefined, a gaveta busca sozinha (uma vez, ao abrir).
  initialContact?: Contact;
  initialTags?: (Tag & { contact_tag_id: string })[];
  initialDeals?: Deal[];
  initialNotes?: ContactNote[];
  // Se veio de um negócio específico (card do Funil, negócio clicado no
  // Inbox), a seção Negócios abre já focada/expandida nele.
  focusDealId?: string;
  onSaved?: () => void; // tela-mãe re-busca o que precisar depois de editar
}
```

Internamente:
- Estado próprio pra cada seção (tags, deals, notes, customFields, details) inicializado a
  partir dos `initial*` props quando presentes.
- `useEffect` que só dispara busca para o que **não** veio como prop (ex.: sempre busca
  `contact_custom_values`, porque nenhuma das 3 telas carrega isso hoje).
- Cache em memória simples, módulo-level (`Map<contactId, {tags, deals, notes, customFields,
  fetchedAt}>`), TTL curto (ex. 60s) ou invalidado no save — se o usuário fechar e abrir a
  gaveta do mesmo contato de novo na mesma sessão sem ter mudado nada, não busca de novo. Sem
  biblioteca nova, só um `Map` no módulo.
- Renderiza `Sheet` (já existe em `src/components/ui/sheet.tsx`) com `Accordion` (já existe em
  `src/components/ui/accordion.tsx`) por dentro — 5 itens, um por seção, colapsados por padrão
  (exceto a seção de `focusDealId`, que abre expandida).

### Seções (conteúdo movido/extraído de `contact-detail-view.tsx`, não reescrito do zero)

1. **Detalhes** — nome, telefone, e-mail, empresa. Reusa o formulário que já existe na aba
   Detalhes de `contact-detail-view.tsx`.
2. **Etiquetas** — grade de tags clicáveis pra alternar (mesmo padrão já existente na aba
   Etiquetas de `contact-detail-view.tsx`, só extraído pra componente próprio reusável).
3. **Negócios** — lista de todos os negócios do contato; cada um com etapa (dropdown, mesmo
   componente que já existe dentro do `DealForm`) e valor editáveis inline, sem abrir outro
   modal. Botão "Criar negócio" só aparece **quando a lista está vazia** (fix do bug relatado).
4. **Notas** — lista + campo de adicionar (mesmo padrão do `contact-sidebar.tsx` hoje).
5. **Campos personalizados** — reusa `custom-fields-manager.tsx` já existente.

`DealForm` como componente próprio deixa de ser aberto direto pelas 3 telas — sua lógica de
edição de negócio (dropdown de etapa, valor, `CorrigirAgendamentoDialog`) migra pra dentro da
seção Negócios da gaveta. Não é descartado, é incorporado.

### Pontos de integração (o que muda em cada tela)

**`deal-card.tsx` / `pipeline-board.tsx` (Funil):** `onEdit(deal)` passa a abrir `ContactDrawer`
em vez de `DealForm`, com `initialContact={deal.contact}`, `initialDeals={[deal]}`,
`focusDealId={deal.id}`. Tags/notas/campos personalizados ainda não existem no board hoje →
buscados pela gaveta na primeira vez que abre (não tem como evitar sem prejudicar a listagem do
board inteiro).

**`contact-sidebar.tsx` (Inbox):** o link do nome do contato (`href="/contacts?contact=..."`)
deixa de navegar — abre `ContactDrawer` com `initialContact`, `initialTags`, `initialDeals`,
`initialNotes` (os 4 já vêm de `fetchContactData`, que já roda hoje) — **zero busca nova** nesse
caminho. Clique num negócio específico abre com `focusDealId` também setado.

**`contact-detail-view.tsx` (Contatos):** deixa de renderizar o painel inline de 5 abas. A lista
de contatos (`contacts/page.tsx`) passa a ocupar a largura toda; clicar num contato abre
`ContactDrawer`. Como essa tela é a "fonte" original de todas as 5 seções, os dados podem vir
direto do que já for buscado pra exibir a linha da lista (ou a gaveta busca completo na
primeira abertura — aceitável aqui, é o ÚNICO ponto de entrada que não tinha problema de
performance reportado).

## Rollout

1. Construir `ContactDrawer` isolado (sem plugar em nenhuma tela), com dados mockados/fixos pra
   validar visualmente as 5 seções antes de integrar.
2. Plugar Funil → build limpo (`tsc --noEmit`, `vitest run`) → confirma visualmente.
3. Plugar Inbox → build limpo → confirma visualmente.
4. Plugar Contatos (substitui o painel inline) → build limpo → confirma visualmente.
5. Só então `pm2 restart wacrm` — muda a experiência das 3 telas de uma vez pra quem estiver
   usando (Márcia inclusive) — avisar antes.

## Fora de escopo (explícito)

- Nenhuma biblioteca de cache/data-fetching nova (SWR, react-query) — decisão deliberada do
  titular, mantém o padrão atual do projeto.
- Nenhuma outra tela além de Inbox/Funil/Contatos.
- Drag-and-drop do Kanban não muda — a gaveta é só um jeito adicional/melhor de editar, não
  substitui mover o card arrastando.
