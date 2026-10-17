-- Run starts and approved workbench continuations use the durable agent-worker queue.
alter table public.job_queue drop constraint if exists job_queue_kind_check;
alter table public.job_queue add constraint job_queue_kind_check check (kind in (
  'inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn','operator_turn',
  'transactional_delivery','approved_reply','workbench_start','workbench_resume'
));

alter table public.job_queue drop constraint if exists job_queue_turn_needs_contact;
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.job_queue'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%contact_id is not null%';
  if c is not null then execute format('alter table public.job_queue drop constraint %I', c); end if;
end $$;
alter table public.job_queue add constraint job_queue_turn_needs_contact check (
  (kind in ('inbound_turn','followup_turn','case_reply_turn','operator_turn','transactional_delivery','approved_reply'))
  = (contact_id is not null)
);
