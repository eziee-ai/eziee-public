-- Iter now ships as Rate: the protocol id `iter` became `rate`, and its tools `iter_*` became `rate_*`.
-- Saved chats keep working: their protocol and the tool parts in their history are renamed in place.
-- Only a part's own `type` (tool-iter_*) or a dynamic tool's `toolName` (iter_*) changes: text and tool output that
-- happen to spell the old names are left exactly as they were.
UPDATE "chats" SET "protocol" = 'rate' WHERE "protocol" = 'iter';
--> statement-breakpoint
UPDATE "messages"
SET "parts" = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(p) = 'object' AND p->>'type' LIKE 'tool-iter\_%' THEN jsonb_set(p, '{type}', to_jsonb('tool-rate_' || substr(p->>'type', 11)))
      WHEN jsonb_typeof(p) = 'object' AND p->>'type' = 'dynamic-tool' AND p->>'toolName' LIKE 'iter\_%' THEN jsonb_set(p, '{toolName}', to_jsonb('rate_' || substr(p->>'toolName', 6)))
      ELSE p
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements("parts") WITH ORDINALITY AS e(p, ord)
)
WHERE jsonb_typeof("parts") = 'array' AND EXISTS (
  SELECT 1 FROM jsonb_array_elements("parts") AS q(p)
  WHERE jsonb_typeof(p) = 'object' AND (p->>'type' LIKE 'tool-iter\_%' OR (p->>'type' = 'dynamic-tool' AND p->>'toolName' LIKE 'iter\_%'))
);
