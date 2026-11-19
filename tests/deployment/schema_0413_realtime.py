"""Actual vendor PG17.6 Realtime contract + fixed 0413 SQL, networkless.

Full old 0412 upgrade is independently tested on PG15/17. This deliberately
minimal FK-parent fixture tests the production vendor partition contract without
inventing a PG15 MAINTAIN ACL or modifying the installed policy module.
"""
import datetime as dt
import importlib.util
import json
from pathlib import Path

HERE=Path(__file__).resolve().parent
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,HERE/file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
vendor=load('reviewed_vendor176','catalog_isolated_test.py')
fixtures=load('fixed0413_realtime','test_schema_0413.py');m=fixtures.m;cp=vendor.policy_module


def run():
    original=vendor.run()  # unchanged hostile DDL/history/restore suite
    db=vendor.IsolatedDatabase();name='catalog_case_413'
    try:
        db.start();db.sql('postgres','CREATE DATABASE '+name);db.sql(name,vendor.DDL)
        db.sql(name,"""CREATE EXTENSION vector WITH SCHEMA public;
          GRANT USAGE,CREATE ON SCHEMA public,auth TO postgres;
          SET ROLE postgres;
          CREATE TABLE public.organizations(id uuid PRIMARY KEY);
          CREATE TABLE public.ai_knowledge_sources(id uuid PRIMARY KEY);
          CREATE TABLE public.ai_knowledge_versions(id uuid PRIMARY KEY);
          CREATE TABLE auth.users(id uuid PRIMARY KEY);
          CREATE FUNCTION public.fn_role_at_least(uuid,text) RETURNS boolean LANGUAGE sql AS 'SELECT false';
          RESET ROLE;""")
        vendor.create_partition(db,name,dt.date(2026,11,16))
        before,topology,_=vendor.snapshot(db,name)
        policy=cp.build_policy(before,cp.digest(before),before,topology,cp.SOURCE_CONTRACT,vendor.NOW)
        raw=(HERE/'fixtures/migration0413.sql.txt').read_bytes();assert m.raw_hash(raw)==m.MIGRATION_SHA256
        db.sql(name,'BEGIN; SET LOCAL ROLE postgres; '+raw.decode()+'; COMMIT;')
        after,after_topology,_=vendor.snapshot(db,name)
        a=m.static_projection(before,topology,policy,vendor.NOW,cp.SOURCE_CONTRACT)
        z=m.static_projection(after,after_topology,policy,vendor.NOW,cp.SOURCE_CONTRACT)
        change=m.delta(a,z);m.verify_change(a,z,{'delta':change,'delta_sha256':m.digest(change)})
        effective={**policy,'static_catalog_sha256':m.digest(z)}
        cp.evaluate(after,after_topology,effective,vendor.NOW,cp.SOURCE_CONTRACT)
        vendor.create_partition(db,name,dt.date(2026,11,18))
        current,current_topology,_=vendor.snapshot(db,name)
        cp.evaluate(current,current_topology,effective,vendor.NOW,cp.SOURCE_CONTRACT,['messages_2026_11_16'])
        db.sql(name,'GRANT SELECT ON realtime.messages_2026_11_18 TO anon;')
        changed,changed_topology,_=vendor.snapshot(db,name)
        try:cp.evaluate(changed,changed_topology,effective,vendor.NOW,cp.SOURCE_CONTRACT)
        except ValueError:pass
        else:raise AssertionError('new_schema_weakened_partition_acl_guard')
        db.sql(name,'REVOKE SELECT ON realtime.messages_2026_11_18 FROM anon; DROP TABLE realtime.messages_2026_11_16;')
        current,current_topology,_=vendor.snapshot(db,name)
        try:cp.evaluate(current,current_topology,effective,vendor.NOW,cp.SOURCE_CONTRACT,['messages_2026_11_16','messages_2026_11_18'])
        except ValueError:pass
        else:raise AssertionError('new_schema_allowed_early_partition_delete')
        cp.evaluate(current,current_topology,effective,'2026-11-22T12:00:00+00:00',cp.SOURCE_CONTRACT,['messages_2026_11_16','messages_2026_11_18'])
        return {'vendor_postgres':vendor.IMAGE,'architecture':'arm64','source_staging_accessed':False,'network':'none',
          'original_vendor_suite':original,'fixed_0413_sql_sha256':m.MIGRATION_SHA256,
          'fixture_scope':'Minimal FK parents + actual0413 SQL; full0412 upgrade covered by pg15/pg17 protocol jobs.',
          'new_static_projection_and_daily_add_pass':True,'legitimate_expiry_pass':True,
          'unauthorized_acl_and_premature_delete_rejected':True,'production_policy_code_and_acl_unchanged':True,
          'model_requests':0,'failures':0}
    finally:db.close()


if __name__=='__main__':
    value=run();dest=HERE.parents[1]/'schema-0413-evidence';dest.mkdir(exist_ok=True)
    (dest/'realtime-vendor176.json').write_text(json.dumps(value,indent=2),encoding='utf8');print(json.dumps(value))
