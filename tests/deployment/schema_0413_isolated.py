"""Fixed 0413 PostgreSQL15/17 laboratory; synthetic source, no host ports/egress."""
import copy
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path

HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[1]
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,HERE/file);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v);return v
old=load('prior_pg0412','schema_0412_isolated.py');fixtures=load('pure0413','test_schema_0413.py')
m=fixtures.m;b=old.b;cp=old.cp
Database=old.Database;Session=old.Session;command=old.command;git_blob=old.git_blob
ORG=old.ORG;USER=old.USER;CONTACT=old.CONTACT;SOURCE=old.SOURCE;VERSION=old.VERSION;KEY=old.KEY


def init(db):
    old.init(db)
    sql=git_blob(m.legacy.REVIEWED_SOURCE,m.legacy.MIGRATION)
    assert m.raw_hash(sql)==m.legacy.MIGRATION_SHA256
    db.sql(sql.decode())
    # Match the existing managed Storage metadata shape, in this test ONLY.
    db.sql('ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS version text, ADD COLUMN IF NOT EXISTS updated_at timestamptz;')


catalog=old.catalog;snapshot=old.snapshot
def reference_policy(before):return old.reference_policy(before)


def test_database(major,dest):
    db=Database(major);passed=[]
    try:
        db.start();init(db)
        before,topology,data_before=snapshot(db);policy=reference_policy(before)
        cp.evaluate(before,topology,policy,old.NOW,cp.SOURCE_CONTRACT)
        state,prior=fixtures.state_and_prior(before,policy)
        migration=git_blob(m.REVIEWED_SOURCE,m.MIGRATION)
        assert m.raw_hash(migration)==m.MIGRATION_SHA256
        try:db.sql('BEGIN; '+migration.decode()+'; SELECT 1/0; COMMIT;')
        except RuntimeError:pass
        else:raise AssertionError('0413_failure_did_not_roll_back')
        rolled,_,rolled_data=snapshot(db);assert rolled==before and rolled_data==data_before
        passed.append('fixed_sql_transaction_failure_preserves_all_0412_catalog_and_data')
        db.sql('BEGIN; '+migration.decode()+'; COMMIT;')
        after,topology_after,data_after=snapshot(db)
        plan=fixtures.approval(before,after,topology,prior,state);m.validate_approval(plan,prior,state)
        a=m.static_projection(before,topology,policy,old.NOW,cp.SOURCE_CONTRACT)
        z=m.static_projection(after,topology_after,policy,old.NOW,cp.SOURCE_CONTRACT)
        m.verify_change(a,z,plan);m.verify_data(data_before,data_after)
        passed.append('actual_fixed_0413_delta_and_old_data_preservation')
        db.sql(migration.decode());assert catalog(db)==after
        passed.append('isolated_sql_idempotent_no_historical_events_or_vectors_rewritten')
        effective={**policy,'static_catalog_sha256':m.digest(z)}
        day=dt.datetime.fromisoformat(old.NOW).date();name='messages_'+day.strftime('%Y_%m_%d')
        db.sql(f"CREATE TABLE realtime.{name} PARTITION OF realtime.messages FOR VALUES FROM ('{day}') TO ('{day+dt.timedelta(days=1)}'); ALTER TABLE realtime.{name} OWNER TO supabase_realtime_admin; SET ROLE supabase_realtime_admin; GRANT ALL ON realtime.{name} TO dashboard_user,postgres; GRANT INSERT,SELECT ON realtime.{name} TO postgres WITH GRANT OPTION; RESET ROLE;")
        cp.evaluate(catalog(db),db.json(cp.INVENTORY_SQL),effective,old.NOW,cp.SOURCE_CONTRACT,[])
        db.sql(f'GRANT SELECT ON realtime.{name} TO anon;')
        try:cp.evaluate(catalog(db),db.json(cp.INVENTORY_SQL),effective,old.NOW,cp.SOURCE_CONTRACT,[])
        except ValueError:pass
        else:raise AssertionError('realtime_unauthorized_acl_accepted')
        db.sql(f'REVOKE SELECT ON realtime.{name} FROM anon; DROP TABLE realtime.{name};')
        try:cp.evaluate(catalog(db),db.json(cp.INVENTORY_SQL),effective,old.NOW,cp.SOURCE_CONTRACT,[name])
        except ValueError:pass
        else:raise AssertionError('premature_partition_deletion_accepted')
        later=(dt.datetime.fromisoformat(old.NOW)+dt.timedelta(days=4)).isoformat()
        cp.evaluate(catalog(db),db.json(cp.INVENTORY_SQL),effective,later,cp.SOURCE_CONTRACT,[name])
        passed.append('unchanged_realtime_contract_allows_daily_add_expiry_and_rejects_acl_or_early_delete')
        hostile=["CREATE TABLE public.unapproved(id int)","CREATE TABLE auth.unapproved(id int)",
          "CREATE TABLE storage.unapproved(id int)","CREATE ROLE schema0413_unapproved SUPERUSER",
          "ALTER TABLE public.ai_embedding_requests DISABLE ROW LEVEL SECURITY",
          "GRANT SELECT ON public.ai_embedding_requests TO authenticated",
          "GRANT UPDATE ON public.ai_embedding_price_reviews TO service_role",
          "CREATE INDEX unapproved_idx ON public.ai_embedding_requests(input_hash)",
          "CREATE FUNCTION public.unapproved_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1'"]
        for i,sql in enumerate(hostile):
            db.sql('CREATE DATABASE schema0412_restore TEMPLATE postgres;')
            try:
                db.sql(sql,'schema0412_restore')
                changed={'postgres':b.catalog_metadata(Session(db,'schema0412_restore')),'_supabase':after['_supabase']}
                if 'CREATE ROLE' in sql:changed['_supabase']=b.catalog_metadata(Session(db,'_supabase'))
                projected=m.static_projection(changed,db.json(cp.INVENTORY_SQL,'schema0412_restore'),policy,old.NOW,cp.SOURCE_CONTRACT)
                try:m.verify_change(a,projected,plan)
                except ValueError:pass
                else:raise AssertionError('unapproved_0413_ddl_accepted_'+str(i))
            finally:
                db.sql('DROP DATABASE schema0412_restore WITH (FORCE);')
                if 'CREATE ROLE' in sql:db.sql('DROP ROLE schema0413_unapproved;')
        passed.append('nine_hostile_changes_rejected_in_real_postgres')
        # Positive + negative tenant permission controls on actual rows.
        other='e4133333-0000-4000-8000-000000000002';review='e4133333-0000-4000-8000-000000000003'
        db.sql(f"INSERT INTO auth.users(id,email) VALUES('{other}','0413-other@invariant.test');")
        db.sql(f"""INSERT INTO public.ai_embedding_price_reviews(id,organization_id,fingerprint,currency,price_per_million_microcents,input_token_ceiling,input_byte_ceiling,evidence_url,evidence_sha256,token_bound_evidence_sha256,reviewed_by,expires_at)
          VALUES('{review}','{ORG}','embedding:v1:{'a'*64}','CNY',1,8192,4096,'https://api-docs.siliconflow.cn/docs/api/embeddings-post','{'a'*64}','{'b'*64}','{USER}',now()+interval '1 hour');""")
        def role_sql(user,query):return db.sql(f"SET ROLE authenticated; SELECT set_config('request.jwt.claims','{{\"sub\":\"{user}\"}}',false); "+query)
        assert role_sql(USER,'SELECT count(*) FROM public.ai_embedding_price_reviews;').splitlines()[-1]=='1'
        assert role_sql(other,'SELECT count(*) FROM public.ai_embedding_price_reviews;').splitlines()[-1]=='0'
        for query in ['SELECT * FROM public.ai_embedding_requests;',"INSERT INTO public.ai_embedding_operations DEFAULT VALUES;",
                      'UPDATE public.ai_embedding_price_reviews SET price_per_million_microcents=0;']:
            try:role_sql(USER,query)
            except RuntimeError:pass
            else:raise AssertionError('ledger_browser_access_not_rejected')
        passed.append('real_tenant_read_and_server_only_request_vectors_and_browser_writes')
        # Ledger fixtures leave the source Schema intact; complete dump/restore
        # and restart use actual pg_dump/pg_restore, not a restore=true mock.
        archive=db.exec(['pg_dump','-h','/tmp/schema0412-socket','-U','postgres','-Fc','postgres'])
        db.sql('CREATE DATABASE schema0412_restore;')
        db.exec(['pg_restore','-h','/tmp/schema0412-socket','-U','postgres','--exit-on-error','-d','schema0412_restore'],archive)
        data=b.data_metadata(Session(db));restored=b.data_metadata(Session(db,'schema0412_restore'))
        assert data==restored and b.catalog_metadata(Session(db))==b.catalog_metadata(Session(db,'schema0412_restore'))
        db.exec(['pg_ctl','-D','/tmp/schema0412-data','-m','fast','-w','restart'])
        assert b.data_metadata(Session(db,'schema0412_restore'))==data
        assert b.catalog_metadata(Session(db))==b.catalog_metadata(Session(db,'schema0412_restore'))
        passed.append('full_catalog_data_restore_and_restart_differences_zero')
        dest.mkdir(parents=True,exist_ok=True)
        (dest/('delta-pg'+major+'.json')).write_text(json.dumps(plan['delta'],sort_keys=True,indent=2),encoding='utf8')
        # Deliberately INVALID as a production approval; independent human action
        # and actual source identity/delta are still required on the VPS.
        proposal={**plan,'approval_id':'NOT-APPROVED','approved_at':None}
        (dest/('proposal-NOT-APPROVED-pg'+major+'.json')).write_text(json.dumps(proposal,indent=2),encoding='utf8')
        return {'postgres_major':major,'architecture':db.image_arch,'source_schema':m.FROM_SCHEMA,'target_schema':m.TO_SCHEMA,
          'reviewed_source':m.REVIEWED_SOURCE,'migration_sha256':m.MIGRATION_SHA256,'delta_sha256':m.digest(plan['delta']),
          'class_counts':{k:{d:len(v[d]) for d in ('added','removed')} for k,v in plan['delta'].items()},
          'passed':passed,'failures':0,'source_staging_accessed':False,'model_requests':0}
    finally:db.close()


if __name__=='__main__':
    major=os.environ.get('TEST_PG_MAJOR','17');dest=ROOT/'schema-0413-evidence'
    result=test_database(major,dest);(dest/('postgres'+major+'.json')).write_text(json.dumps(result,indent=2),encoding='utf8');print(json.dumps(result))
