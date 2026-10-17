-- 0404 — bind a verified WAHA callback to the exact CRM message it inserted.
-- External IDs alone are not a trustworthy origin witness: unsigned WAHA Core
-- callbacks and other CRM writers can also create message rows with an ID.
alter table public.webhook_events_log
  add column if not exists crm_inbound_message_id uuid
    references public.messages(id) on delete set null;
alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_signed_inbound_shape;
alter table public.webhook_events_log
  add constraint webhook_events_log_signed_inbound_shape check (
    crm_inbound_message_id is null or (
      provider='waha' and valid_signature is true
      and event_type in ('message','message.any')
      and organization_id is not null and channel_session_id is not null
      and external_id is not null
    )
  );
create unique index if not exists webhook_events_log_signed_inbound_uidx
  on public.webhook_events_log(crm_inbound_message_id)
  where crm_inbound_message_id is not null;
notify pgrst, 'reload schema';
