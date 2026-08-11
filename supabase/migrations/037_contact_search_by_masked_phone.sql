-- ============================================================
-- 037 — Contact search accepts the phone as the CRM displays it
--
-- The contact list shows the number masked: "(12) 99162-4095".
-- Copying that straight back into the search box never matched,
-- because `contacts.phone` stores it unmasked ("+5512991624095")
-- and the search compared the typed text literally.
--
-- `phone_normalized` already holds the digits with no mask, so the
-- fix is to strip everything that is not a digit from the term and
-- compare against that column too. Text terms (a name, an e-mail)
-- keep hitting the columns they always did.
--
-- Four digits is the floor: a shorter fragment matches most of the
-- base and helps nobody.
--
-- Mirrors the same rule applied to the unfiltered list query in
-- src/app/(dashboard)/contacts/page.tsx — the two paths must agree,
-- otherwise the search behaves differently with a tag filter on.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH term AS (
    SELECT
      p_search AS raw,
      NULLIF(regexp_replace(COALESCE(p_search, ''), '\D', '', 'g'), '') AS digits
  ),
  matched AS (
    -- Distinct contacts having ANY of the selected tags (OR),
    -- narrowed by the same name/phone/email/number search as the list.
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    CROSS JOIN term
    WHERE ct.tag_id = ANY(p_tag_ids)
      AND (
        term.raw IS NULL
        OR c.name ILIKE '%' || term.raw || '%'
        OR c.phone ILIKE '%' || term.raw || '%'
        OR c.email ILIKE '%' || term.raw || '%'
        OR (
          length(term.digits) >= 4
          AND c.phone_normalized ILIKE '%' || term.digits || '%'
        )
      )
  ),
  page AS (
    -- count(*) OVER() is evaluated before LIMIT, so it is the full
    -- match total regardless of the page being returned.
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) TO authenticated;
