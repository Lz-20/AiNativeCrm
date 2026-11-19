#!/usr/bin/env python3
"""Local root-only fixed 0413 entry. Not an SSH/deployment operation.

Only --apply and explicit evidence-only --register exist. No SQL/path/source,
target container, arbitrary Schema, automatic retry or image update arguments.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys


def local_module(name):
    spec=importlib.util.spec_from_file_location('migration413_'+name,Path(__file__).with_name(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


previous=local_module('migrate_0412')
e=previous.e;b=previous.b;cp=previous.cp;m=local_module('schema_0413')
existing_lock=previous.existing_lock
INSTALL=previous.INSTALL


class RootMigrationRuntime(previous.RootMigrationRuntime):
    def __init__(self):
        # Preserves the original policy + original/history authentication and all
        # old module/SQL security checks. Does not execute any 0412 migration.
        super().__init__()
        for name in ('migrate_0413.py','schema_0413.py','migration-0413.sql'):e.secure_path(INSTALL/name)
        m.need(Path(__file__).resolve()==INSTALL/'migrate_0413.py','schema0413_installed_entry_only')
        self._prior=m.legacy.read_context(self.load_state(),self._policy,cp)
        m.prior_registration(self._prior)
        self.root.verify_current(self.load_state())

    def prior_context(self):return self._prior
    def old_policy(self):return self._prior['policy']
    def approval(self):return m.read(m.APPROVAL)
    def migration_bytes(self):return (INSTALL/'migration-0413.sql').read_bytes()
    def assert_embedding_disabled(self):
        with b.Snapshot(b.SOURCE_CONTAINER_ID,'postgres') as session:
            b.source_identity(session)
            m.need(session.json('SELECT to_jsonb(NOT EXISTS(SELECT 1 FROM public.ai_embedding_configurations WHERE enabled))'),
                   'schema0413_embedding_must_be_disabled')

    def start_journal(self,journal,state):
        m.need(not m.DIRECTORY.exists() and not m.DIRECTORY.is_symlink(),'schema0413_already_started')
        m.DIRECTORY.mkdir(mode=0o700)
        for name,value in [('state-before.json',state),('prior-registration.json',m.prior_registration(self._prior)),
                           ('approval-copy.json',self.approval())]:b.write_json(m.DIRECTORY/name,value)
        self.write_journal(journal);self.audit({'phase':'schema0413_started','approval_sha256':m.digest(self.approval())})

    def write_journal(self,value):e.atomic_json(m.JOURNAL,value)

    def transaction(self,approval,proof):
        m.authenticate_backup(proof)
        with existing_lock(e.STATE/'backup.lock'):
            with b.Snapshot(b.SOURCE_CONTAINER_ID,'postgres',m.DIRECTORY/'migration-psql.log') as session, \
                 b.Snapshot(b.SOURCE_CONTAINER_ID,'_supabase') as secondary:
                b.source_identity(session)
                session.query("ROLLBACK; BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'; SET LOCAL search_path=pg_catalog; SELECT pg_advisory_xact_lock(413,20261119); LOCK TABLE public.ai_embedding_configurations,public.ai_knowledge_versions,public.ai_knowledge_sources IN SHARE ROW EXCLUSIVE MODE")
                m.need(session.json('SELECT to_jsonb(NOT EXISTS(SELECT 1 FROM public.ai_embedding_configurations WHERE enabled))'),
                       'schema0413_embedding_must_be_disabled')
                before={'postgres':b.catalog_metadata(session),'_supabase':b.catalog_metadata(secondary)}
                topology_before=session.json(cp.INVENTORY_SQL)
                cp.evaluate(before,topology_before,self.old_policy(),e.utcnow(),b.realtime_origin(cp))
                m.need(m.digest(before)==proof['source_catalog_sha256'],'schema0413_catalog_changed_since_backup')
                data_before=b.data_metadata(session)
                sql=self.migration_bytes();m.need(m.raw_hash(sql)==m.MIGRATION_SHA256,'schema0413_migration_bytes')
                session.query('SET LOCAL ROLE postgres');session.query(sql.decode('utf8'));session.query('RESET ROLE')
                after={'postgres':b.catalog_metadata(session),'_supabase':b.catalog_metadata(secondary)}
                topology_after=session.json(cp.INVENTORY_SQL);when=e.utcnow()
                a=m.static_projection(before,topology_before,self.old_policy(),when,cp.SOURCE_CONTRACT)
                z=m.static_projection(after,topology_after,self.old_policy(),when,cp.SOURCE_CONTRACT)
                m.verify_change(a,z,approval);data_after=b.data_metadata(session);data=m.verify_data(data_before,data_after)
                values={'catalog-before.json':before,'catalog-after.json':after,'partition-before.json':topology_before,
                  'partition-after.json':topology_after,'backup-before.json':proof,'data-proof.json':data,
                  'data-before.json':data_before,'data-after.json':data_after,
                  'state-before.json':m.read(m.DIRECTORY/'state-before.json'),
                  'prior-registration.json':m.read(m.DIRECTORY/'prior-registration.json')}
                m.catalog_context(approval,values,self._prior,cp,when)
                for name,value in values.items():
                    path=m.DIRECTORY/name
                    if path.exists():m.need(m.read(path)==value,'schema0413_immutable_evidence_changed')
                    else:b.write_json(path,value)
                b.write_json(m.DIRECTORY/'transaction.json',{'format':1,'approval_sha256':m.digest(approval),
                  'files':{n:m.digest(v) for n,v in values.items()},'completed_at':when})
                self.write_journal({'format':1,'transition':'rag-0413','phase':'validated','approval_sha256':m.digest(approval)})
                m.need(self.load_state()==values['state-before.json'],'schema0413_state_changed_before_commit')
                # Lost acknowledgement leaves validated/unknown journal and
                # blocks deployment. Never infer rollback or rerun the SQL.
                session.query('COMMIT')
        return values

    def post_backup_and_receipt(self,approval,result,proof):
        with existing_lock(e.STATE/'backup.lock'):post=b.verify_backup(allow_0413_pending=True)
        m.verify_backup_proof(post);m.authenticate_backup(post)
        path=m.DIRECTORY/'backup-after.json'
        if path.exists():b.write_json(m.DIRECTORY/('registration-check-'+os.urandom(8).hex()+'.json'),post)
        else:b.write_json(path,post)
        values={name:m.read(m.DIRECTORY/name) for name in m.EVIDENCE_FILES}
        when=m.read(m.DIRECTORY/'transaction.json')['completed_at']
        a,z,_=m.catalog_context(approval,values,self._prior,cp,when)
        m.need(post.get('static_catalog_sha256')==m.digest(z),'schema0413_post_restore_static')
        if (m.DIRECTORY/'receipt.json').exists():receipt=m.read(m.DIRECTORY/'receipt.json')
        else:receipt={'format':1,'transition':'rag-0413','approval_sha256':m.digest(approval),
          'prior_receipt_sha256':self._prior['receipt_sha256'],'files':m.evidence_inventory(values),
          'before_catalog_sha256':m.digest(values['catalog-before.json']),'after_catalog_sha256':m.digest(values['catalog-after.json']),
          'before_static_sha256':m.digest(a),'after_static_sha256':m.digest(z),'completed_at':when}
        context=m.validate_receipt(approval,receipt,values,self._prior,self.load_state(),cp);context['post_backup']=post
        return context

    def write_receipt(self,context):
        path=m.DIRECTORY/'receipt.json'
        if path.exists():m.need(m.read(path)==context['receipt'],'schema0413_existing_receipt_changed')
        else:b.write_json(path,context['receipt'])

    def complete_registration(self):
        state=self.load_state();old=m.read(m.DIRECTORY/'state-before.json')
        m.need(not state.get('pending') and state.get('current')==old.get('current'),'schema0413_recovery_state_changed')
        self.assert_embedding_disabled()
        approval=m.validate_approval(self.approval(),self._prior,state)
        context=m.read_context(state,self._policy,cp,allow_pending=True)
        m.need(context is not None,'schema0413_recovery_evidence_required')
        final=self.post_backup_and_receipt(approval,None,None)
        expected={**old,'schema_0413':m.registration(final)}
        m.need(state in (old,expected) and self.load_state()==state,'schema0413_recovery_state_changed')
        self.write_receipt(final);self.save_state(expected)
        self.write_journal({'format':1,'transition':'rag-0413','phase':'registered','approval_sha256':m.digest(approval)})
        self.audit({'phase':'schema0413_registration_recovered','receipt_sha256':final['receipt_sha256']})
        return m.registration(final)


def main():
    m.need(os.geteuid()==0 and sys.platform=='linux','schema0413_root_linux_required')
    m.need(sys.argv[1:] in (['--apply'],['--register']),'schema0413_fixed_operation_required')
    os.environ.clear();os.environ.update(e.FIXED_ENV)
    runtime=RootMigrationRuntime()
    with existing_lock(e.STATE/'deployment.lock'):
        result=m.MigrationCoordinator(runtime).run() if sys.argv[1:]==['--apply'] else runtime.complete_registration()
    print(json.dumps({'ok':True,**result},sort_keys=True))


if __name__=='__main__':
    try:main()
    except (e.Failure,m.TransitionError) as error:
        print(json.dumps({'ok':False,'error':error.code}),file=sys.stderr);sys.exit(1)
