-- ============================================================
-- flow_nodes.node_type — add 'wait', 'offer_slots', 'book_meeting',
-- 'cancel_meeting'
--
-- 'wait' shipped earlier today (engine.ts wait-node handler + the
-- flow_pending_resumes table in 041) but never extended this CHECK
-- constraint. offer_slots/book_meeting/cancel_meeting ship in this same
-- phase. None of the three new Cal.com node types nor 'wait' can be
-- persisted to flow_nodes until this runs — the constraint is the only
-- gate (no zod/enum validation exists at the API layer, confirmed by
-- reading src/app/api/flows/[id]/route.ts, which types node_type as a
-- bare string).
-- ============================================================
ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'wait',
    'offer_slots',
    'book_meeting',
    'cancel_meeting',
    'end'
  ));
