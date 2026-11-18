"""Execute the production transaction method on a validated networkless fixture.

Only source binding/origin and the already-covered external backup reader are
injected. PostgreSQL, locks, transaction, Catalog/data checks and evidence files
are real. These fixture receipts are NOT production restore attestations.
"""
import contextlib
import copy
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
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
pg=load('adapter_pg',HERE/'schema_0412_isolated.py')
rt=load('actual_migrator',pg.ROOT/'deploy/staging/migrate_0412.py')


def run():
    assert os.geteuid()==0
    major=os.environ.get('TEST_PG_MAJOR','17');db=pg.Database(major)
    private=Path('/root')/('schema0412-adapter-ci-'+uuid.uuid4().hex)
    private.mkdir(mode=0o700);state_dir=private/'state';state_dir.mkdir(mode=0o700)
    directory=state_dir/'schema-0412';directory.mkdir(mode=0o700)
    (state_dir/'backup.lock').touch(mode=0o600)
    (state_dir/'deployment.lock').touch(mode=0o600)
    try:
        db.start();db.sql('CREATE ROLE supabase_admin SUPERUSER LOGIN;');pg.init(db)
        before,topology,_=pg.snapshot(db);policy=pg.reference_policy(before)
        sql=pg.git_blob(pg.m.REVIEWED_SOURCE,pg.m.MIGRATION)
        db.sql('CREATE DATABASE schema0412_restore TEMPLATE postgres;')
        db.sql(sql.decode(),'schema0412_restore')
        after={'postgres':pg.b.catalog_metadata(pg.Session(db,'schema0412_restore')),'_supabase':before['_supabase']}
        change=pg.m.delta(before,after);pg.m.check_delta_scope(change)
        db.sql('DROP DATABASE schema0412_restore WITH (FORCE);')
        system_id=db.sql('SELECT system_identifier::text FROM pg_control_system()')
        def fixture_identity(value):
            # Production remains pinned to Staging 17.6. This process accepts
            # only this labelled disposable cluster and the requested test major.
            assert value['system_identifier']==system_id
            assert value['server_version'].split('.')[0]==major
            assert set(value['databases'])=={'postgres','_supabase'}
        state={'current':{'sha':'synthetic-current'},'pending':None}
        def state_value():return copy.deepcopy(state)
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.multiple(rt.b,SOURCE_CONTAINER_ID=db.cid,SOURCE_SYSTEM_ID=system_id))
            stack.enter_context(patch.object(rt.b,'validate_identity',fixture_identity))
            stack.enter_context(patch.multiple(rt.e,STATE=state_dir))
            stack.enter_context(rt.existing_lock(state_dir/'deployment.lock'))
            stack.enter_context(patch.multiple(rt.m,STATE=state_dir,DIRECTORY=directory,JOURNAL=directory/'journal.json'))
            stack.enter_context(patch.object(rt.b,'realtime_origin',lambda _:rt.cp.SOURCE_CONTRACT))
            stack.enter_context(patch.object(rt.m,'authenticate_backup',lambda proof: proof))
            runtime=object.__new__(rt.RootMigrationRuntime)
            runtime._policy=policy;runtime.root=SimpleNamespace(load_state=state_value,audit=lambda _: None)
            runtime.migration_bytes=lambda:sql
            rt.b.write_json(directory/'state-before.json',state)
            approval={'delta':change,'delta_sha256':pg.m.digest(change)}
            proof={'source_catalog_sha256':pg.m.digest(before)}
            # A bad independent approval must roll back the actual production
            # transaction method, not only an analogous psql script.
            bad={'delta':{},'delta_sha256':pg.m.digest({})}
            try:runtime.transaction(bad,proof)
            except rt.m.TransitionError:pass
            else:raise AssertionError('bad_delta_did_not_abort_actual_transaction')
            assert pg.catalog(db)==before
            runtime.write_journal({'format':1,'transition':'embedding-0412','phase':'transaction_failed_or_unknown',
              'approval_sha256':pg.m.digest(approval)})
            # Retrying a proven rollback archives the entire failed attempt.
            # Outer coordinator behavior is separately tested; do not execute
            # the SQL again here until a new approval attempt below.
            with patch.object(rt.m,'MigrationCoordinator',lambda _:SimpleNamespace(run=lambda:{'retried':True})):
                assert runtime.retry_proven_rollback()=={'retried':True}
            archives=list((state_dir/'schema-0412-attempts').iterdir())
            assert len(archives)==1 and (archives[0]/'migration-psql.log').exists() and not directory.exists()
            # The first private log is preserved, so the second attempt uses a
            # fresh fixture evidence directory rather than overwriting it.
            directory2=state_dir/'attempt-two';directory2.mkdir(mode=0o700)
            stack.enter_context(patch.multiple(rt.m,DIRECTORY=directory2,JOURNAL=directory2/'journal.json'))
            rt.b.write_json(directory2/'state-before.json',state)
            runtime.transaction(approval,proof)
            assert pg.catalog(db)==after
            assert rt.m.read(directory2/'data-proof.json')['unchanged'] is True
            assert rt.m.read(directory2/'journal.json')['phase']=='validated'
            try:runtime.retry_proven_rollback()
            except ValueError:pass
            else:raise AssertionError('committed_schema_was_allowed_to_retry_SQL')
            assert directory2.exists()
            assert state=={'current':{'sha':'synthetic-current'},'pending':None}
        result={'postgres_major':major,'actual_production_transaction_method':True,'wrong_delta_real_rollback':True,
          'approved_delta_real_commit':True,'old_data_preserved':True,'real_root_lock_files':True,
          'retry_archives_only_proven_rollback':True,'committed_schema_cannot_be_retried':True,
          'source_binding':'controlled_fixture_not_staging','external_restore_reader':'independently_tested_not_invoked_here',
          'business_image_updates':0,'model_requests':0,'failures':0}
        dest=pg.ROOT/'schema-0412-evidence';dest.mkdir(exist_ok=True)
        (dest/('production-adapter-pg'+major+'.json')).write_text(json.dumps(result,indent=2),encoding='utf8')
        print(json.dumps(result))
    finally:
        db.close()
        assert private.parent==Path('/root') and private.name.startswith('schema0412-adapter-ci-')
        shutil.rmtree(private)


if __name__=='__main__':run()
