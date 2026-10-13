-- The owner's decision (0054, 2026-10-13): stock adjustments and count differences no longer need a
-- supervisor's approval, whatever their value. The rule stays in the database: the setting is
-- empty (no limit); putting a value back (in fils) turns the approval on again.

SELECT sys.set_context(1, p_reason => 'migration 0021: no supervisor approval for stock adjustments (decision 0054)');

UPDATE sys.settings
   SET value = 'null'::jsonb,
       description = 'Adjustments above this value (fils) need approval; empty = no approval needed (decision 0054)'
 WHERE key = 'inventory.adjustment_approval_threshold_fils';
