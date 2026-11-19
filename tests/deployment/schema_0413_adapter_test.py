"""Actual production transaction adapter, only on labelled networkless PG.

Source binding and the separately file-tested external restore reader are
injected. SQL, Catalog/data checks, locks and private evidence files are real.
"""
import copy
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
from types import SimpleNamespace
from unittest.mock import patch
import uuid

HERE=Path(__file__).resolve().parent
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v);return v
pg=load('adapter_0413_pg',HERE/'schema_0413_isolated.py')
rt=load('actual_migrate0413',pg.ROOT/'deploy/staging/migrate_0413.py')


def run():
    assert os.geteuid()==0
    major=os.environ.get('TEST_PG_MAJOR','17');db=pg.Database(major)
    private=Path('/root')/('schema0413-adapter-ci-'+uuid.uuid4().hex);private.mkdir(mode=0o700)
    state_dir=private/'state';state_dir.mkdir(mode=0o700)
    for name in ('deployment.lock','backup.lock'):(state_dir/name).touch(mode=0o600)
    try:
        db.start();db.sql('CREATE ROLE supabase_admin SUPERUSER LOGIN;');pg.init(db)
        before,topology,_=pg.snapshot(db);policy=pg.reference_policy(before)
        state,prior=pg.fixtures.state_and_prior(before,policy)
        sql=pg.git_blob(rt.m.REVIEWED_SOURCE,rt.m.MIGRATION)
        db.sql('CREATE DATABASE schema0412_restore TEMPLATE postgres;');db.sql(sql.decode(),'schema0412_restore')
        after={'postgres':pg.b.catalog_metadata(pg.Session(db,'schema0412_restore')),'_supabase':before['_supabase']}
        plan=pg.fixtures.approval(before,after,topology,prior,state)
        db.sql('DROP DATABASE schema0412_restore WITH (FORCE);')
        system=db.sql('SELECT system_identifier::text FROM pg_control_system()')
        def fixture_identity(value):
            db.check();assert value['system_identifier']==system and value['server_version'].split('.')[0]==major
        proof={'restore_verified':True,'differences':0,'source_system_identifier':rt.m.SYSTEM_ID,'source_database':'postgres',
          'evidence_sha256':'d'*64,'source_catalog_sha256':rt.m.digest(before)}
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.multiple(rt.b,SOURCE_CONTAINER_ID=db.cid,SOURCE_SYSTEM_ID=system))
            stack.enter_context(patch.object(rt.b,'validate_identity',fixture_identity))
            stack.enter_context(patch.object(rt.b,'realtime_origin',lambda _:rt.cp.SOURCE_CONTRACT))
            stack.enter_context(patch.object(rt.m,'authenticate_backup',lambda proof:proof))
            stack.enter_context(patch.object(rt.e,'STATE',state_dir))
            stack.enter_context(rt.existing_lock(state_dir/'deployment.lock'))
            runtime=object.__new__(rt.RootMigrationRuntime);runtime._prior=prior;runtime._policy=policy
            runtime.root=SimpleNamespace(load_state=lambda:copy.deepcopy(state),audit=lambda _:None)
            runtime.migration_bytes=lambda:sql
            for label,approval in [('rejected',{**plan,'delta':{},'delta_sha256':rt.m.digest({})}),('commit-registration-failure',plan)]:
                directory=state_dir/label
                with patch.multiple(rt.m,STATE=state_dir,DIRECTORY=directory,JOURNAL=directory/'journal.json'):
                    runtime.approval=lambda:approval
                    runtime.fresh_backup_before=lambda _:proof
                    # A post-COMMIT restore/registration failure must preserve
                    # expanded Schema + old App/state and block further DDL.
                    runtime.post_backup_and_receipt=lambda *_: (_ for _ in ()).throw(RuntimeError('fixture_registration_unavailable'))
                    try:rt.m.MigrationCoordinator(runtime).run()
                    except (ValueError,RuntimeError):pass
                    else:raise AssertionError('expected_failure_missing')
                    if label=='rejected':
                        # Approval scope fails before any source SQL or journal.
                        assert pg.catalog(db)==before and not directory.exists()
                        # Execute the real adapter with mismatched exact rows to
                        # prove the SQL is rolled back BEFORE COMMIT as well.
                        directory.mkdir(mode=0o700);rt.b.write_json(directory/'state-before.json',state)
                        rt.b.write_json(directory/'prior-registration.json',state['schema_0412'])
                        try:runtime.transaction(approval,proof)
                        except ValueError:pass
                        else:raise AssertionError('bad_catalog_did_not_roll_back')
                        assert pg.catalog(db)==before
                    else:
                        assert pg.catalog(db)==after
                        assert rt.m.read(directory/'journal.json')['phase']=='registration_failed'
                        assert 'schema_0413' not in state and state['current']['sha']==rt.m.FROM_SOURCE
                        try:rt.m.MigrationCoordinator(runtime).run()
                        except ValueError:pass
                        else:raise AssertionError('registered_or_committed_sql_repeated')
                        assert pg.catalog(db)==after
        result={'postgres_major':major,'actual_production_transaction_method':True,'wrong_delta_real_sql_rollback':True,
          'approved_delta_real_commit':True,'post_commit_failure_keeps_old_state_and_expanded_schema':True,
          'no_automatic_sql_retry':True,'real_root_lock_files':True,'source_binding':'labelled_disposable_cluster_only',
          'restore_reader':'physical_root_file_tests_and_real_pg_restore_test_separate','business_updates':0,'model_requests':0,'failures':0}
        dest=pg.ROOT/'schema-0413-evidence';dest.mkdir(exist_ok=True)
        (dest/('production-adapter-pg'+major+'.json')).write_text(json.dumps(result,indent=2),encoding='utf8');print(json.dumps(result))
    finally:
        db.close();assert private.parent==Path('/root') and private.name.startswith('schema0413-adapter-ci-');shutil.rmtree(private)


if __name__=='__main__':run()
