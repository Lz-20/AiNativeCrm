-- 0390 — a schema-validated model statement is separate from CRM facts/actions.
-- NULL keeps historical runs and incomplete/provider-failed runs readable.
alter table public.ai_workbench_runs
  add column if not exists result_document jsonb;

alter table public.ai_workbench_runs
  drop constraint if exists ai_workbench_runs_result_document_shape_check;
alter table public.ai_workbench_runs
  add constraint ai_workbench_runs_result_document_shape_check
  check (result_document is null or coalesce((
    jsonb_typeof(result_document) = 'object'
    and result_document->>'revision' = '1'
    and result_document->>'trust' = 'model_submitted'
    and jsonb_typeof(result_document->'summary') = 'string'
    and jsonb_typeof(result_document->'evidence') = 'array'
    and jsonb_typeof(result_document->'missingInformation') = 'array'
    and jsonb_typeof(result_document->'nextStep') = 'string'
    and result_document->>'wakeCondition' in
      ('none', 'customer_reply', 'human_approval', 'internal_response', 'deadline')
  ), false));

comment on column public.ai_workbench_runs.result_document is
  'Bounded model-submitted result, not independent proof of business outcome or action execution.';

notify pgrst, 'reload schema';
