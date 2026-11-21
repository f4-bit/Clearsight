-- 3.6: bounded publication reconciliation scans terminal executions ordered by
-- age. `inferences` had no status index, so this additive partial index keeps
-- the candidate query from scanning every execution. It does not change data,
-- constraints or historical migrations.
CREATE INDEX IF NOT EXISTS idx_inferences_publication_reconcile
    ON inferences (created_at, id)
    WHERE status IN ('COMPLETED', 'REVIEW_REQUIRED');
