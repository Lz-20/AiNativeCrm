#!/usr/bin/env python3
"""Local root-only fixed 0412 maintenance entry. Never exposed by forced SSH.

No URL, SQL, container, file path or image argument is accepted. Requires an
independently reviewed root approval and a separately installed fixed SQL blob.
No business image is pulled, replaced, relabeled or rolled back by this entry.
"""
import contextlib
import datetime as dt
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import sys

INSTALL=Path('/usr/local/libexec/ainativecrm-staging')


def local_module(name):
    spec=importlib.util.spec_from_file_location('migration_'+name,Path(__file__).with_name(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


e=local_module('engine');b=local_module('backup_verify');m=local_module('schema_0412');cp=local_module('catalog_policy')


@contextlib.contextmanager
def existing_lock(path):
    e.secure_path(path,mode=0o600)
    fd=os.open(path,os.O_RDWR|os.O_NOFOLLOW)
    try:
        before=path.stat();opened=os.fstat(fd)
        m.need((before.st_dev,before.st_ino)==(opened.st_dev,opened.st_ino),'schema0412_lock_inode')
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise m.TransitionError('schema0412_lock_busy') from None
        yield
    finally:os.close(fd)


def normalized_data(session, expanded):
    values=b.data_metadata(session)
    # Adding a nullable column changes to_jsonb(row), even without changing data.
    # Only this exact new column is projected; every old column and row stays.
    if expanded:
        m.need(session.json('SELECT NOT EXISTS(SELECT 1 FROM public.ai_knowledge_versions WHERE embedding_profile IS NOT NULL)'),
               'schema0412_new_profile_not_disabled')
        values['public.ai_knowledge_versions']=session.json("SELECT jsonb_build_object('count',count(*),'hash',md5(coalesce(string_agg(j,E'\\n' ORDER BY j),''))) FROM (SELECT (to_jsonb(t)-'embedding_profile')::text AS j FROM public.ai_knowledge_versions t) rows")
    return values


class RootMigrationRuntime:
    def __init__(self):
        self.root=e.RootRuntime()
        for name in ['migrate_0412.py','schema_0412.py','catalog_policy.py','migration-0412.sql']:e.secure_path(INSTALL/name)
        m.need(Path(__file__).resolve()==INSTALL/'migrate_0412.py','schema0412_installed_entry_only')
        e.secure_path(e.CONFIG/'catalog-policy.json',mode=0o600)
        self._policy=cp.parse_policy((e.CONFIG/'catalog-policy.json').read_bytes())
        cp.validate_policy(self._policy,self.load_state()['approved_catalog_sha256'])
        # Reauthenticate the existing independent original/history receipts;
        # no restore, source writes, baseline replacement or guessed OIDs.
        b.read_approved_history(cp,e.STATE/'backups'/'20261117T025329Z-d3302afc',
            e.STATE/'catalog-history'/'20261117T071212Z-2a57314d',self.load_state()['approved_catalog_sha256'],
            '16555733a88dda76876da8573109771e3c2589a1e0eee0132f4577e15b13455a',
            '069d806d6477d8611617f336bdf3dec3ed32a85bdc4a7f6c6bc72d95a186f9fa')

    def load_state(self):return self.root.load_state()
    def save_state(self,state):self.root.save_state(state)
    def old_policy(self):return self._policy
    def approval(self):return m.read(m.APPROVAL)
    def migration_bytes(self):return (INSTALL/'migration-0412.sql').read_bytes()
    def audit(self,event):self.root.audit({**event,'at':e.utcnow()})
    def fresh_backup_before(self,state):return self.root.ensure_backup(state)
    def start_journal(self,journal,state):
        m.need(not m.DIRECTORY.exists() and not m.DIRECTORY.is_symlink(),'schema0412_already_started')
        m.DIRECTORY.mkdir(mode=0o700)
        b.write_json(m.DIRECTORY/'state-before.json',state)
        b.write_json(m.DIRECTORY/'policy-before.json',self._policy)
        b.write_json(m.DIRECTORY/'approval-copy.json',self.approval())
        self.write_journal(journal)
        self.audit({'phase':'schema0412_started','approval_sha256':m.digest(self.approval())})
    def write_journal(self,value):e.atomic_json(m.JOURNAL,value)

    def transaction(self,approval,proof):
        m.authenticate_backup(proof)
        # Deployment lock remains held throughout; backup.lock is taken only
        # after the old helper has released it. Neither inode is replaced.
        with existing_lock(e.STATE/'backup.lock'):
            with b.Snapshot(b.SOURCE_CONTAINER_ID,'postgres',m.DIRECTORY/'migration-psql.log') as session, \
                 b.Snapshot(b.SOURCE_CONTAINER_ID,'_supabase') as secondary:
                b.source_identity(session)
                session.query("ROLLBACK; BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'; SET LOCAL search_path=pg_catalog; SELECT pg_advisory_xact_lock(412,20261118); LOCK TABLE public.ai_knowledge_versions,public.ai_knowledge_sources,public.ai_chunks IN SHARE ROW EXCLUSIVE MODE")
                before={'postgres':b.catalog_metadata(session),'_supabase':b.catalog_metadata(secondary)}
                topology_before=session.json(cp.INVENTORY_SQL)
                cp.evaluate(before,topology_before,self._policy,e.utcnow(),b.realtime_origin(cp))
                m.need(m.digest(before)==proof['source_catalog_sha256'],'schema0412_catalog_changed_since_backup')
                data_before=normalized_data(session,False)
                sql=self.migration_bytes();m.need(m.raw_hash(sql)==m.MIGRATION_SHA256,'schema0412_migration_bytes')
                session.query('SET LOCAL ROLE postgres')
                session.query(sql.decode('utf8'))
                session.query('RESET ROLE')
                after={'postgres':b.catalog_metadata(session),'_supabase':b.catalog_metadata(secondary)}
                topology_after=session.json(cp.INVENTORY_SQL)
                when=e.utcnow()
                static_before=m.static_projection(before,topology_before,self._policy,when,cp.SOURCE_CONTRACT)
                static_after=m.static_projection(after,topology_after,self._policy,when,cp.SOURCE_CONTRACT)
                m.verify_change(static_before,static_after,approval)
                data=m.verify_data(data_before,normalized_data(session,True))
                values={'catalog-before.json':before,'catalog-after.json':after,'partition-before.json':topology_before,
                        'partition-after.json':topology_after,'backup-before.json':proof,'data-proof.json':data}
                for name,value in values.items():b.write_json(m.DIRECTORY/name,value)
                b.write_json(m.DIRECTORY/'transaction.json',{'format':1,'approval_sha256':m.digest(approval),
                  'files':{n:m.digest(v) for n,v in values.items()},'completed_at':when})
                self.write_journal({'format':1,'transition':'embedding-0412','phase':'validated','approval_sha256':m.digest(approval)})
                # Any exception before this statement leaves Snapshot's ROLLBACK
                # active. A lost COMMIT acknowledgement leaves the durable journal.
                session.query('COMMIT')
        return values

    def post_backup_and_receipt(self,approval,result,proof):
        # No caller supplied extension bypass: the helper independently reloads
        # this root approval, transaction receipt and exact before/after delta.
        with existing_lock(e.STATE/'backup.lock'):
            post=b.verify_backup(allow_0412_pending=True)
        m.verify_backup_proof(post);m.authenticate_backup(post)
        if (m.DIRECTORY/'backup-after.json').exists():
            # Registration retry never overwrites the first successful proof.
            b.write_json(m.DIRECTORY/('registration-check-'+os.urandom(8).hex()+'.json'),post)
            post_saved=m.read(m.DIRECTORY/'backup-after.json')
        else:
            b.write_json(m.DIRECTORY/'backup-after.json',post);post_saved=post
        values={name:m.read(m.DIRECTORY/name) for name in m.EVIDENCE_FILES}
        when=m.read(m.DIRECTORY/'transaction.json')['completed_at']
        a,z,effective=m.catalog_context(approval,values,self._policy,cp,when)
        m.need(post.get('static_catalog_sha256')==m.digest(z),'schema0412_post_restore_static')
        if (m.DIRECTORY/'receipt.json').exists():receipt=m.read(m.DIRECTORY/'receipt.json')
        else:
            receipt={'format':1,'transition':'embedding-0412','approval_sha256':m.digest(approval),
              'files':m.evidence_inventory(values),'before_catalog_sha256':m.digest(values['catalog-before.json']),
              'after_catalog_sha256':m.digest(values['catalog-after.json']),
              'before_static_sha256':m.digest(a),'after_static_sha256':m.digest(z),'completed_at':when}
        context=m.validate_receipt(approval,receipt,values,self._policy,self.load_state(),cp)
        context['post_backup']=post
        return context

    def write_receipt(self,context):
        path=m.DIRECTORY/'receipt.json'
        if path.exists():m.need(m.read(path)==context['receipt'],'schema0412_existing_receipt_changed')
        else:b.write_json(path,context['receipt'])

    def complete_registration(self):
        # Explicit local recovery operation; never re-executes the SQL blob.
        state=self.load_state();old=m.read(m.DIRECTORY/'state-before.json')
        m.need(not state.get('pending') and state.get('current')==old.get('current'),'schema0412_recovery_state_changed')
        approval=m.validate_approval(self.approval(),self._policy,state)
        context=m.read_context(state,self._policy,cp,allow_pending=True)
        m.need(context is not None,'schema0412_recovery_evidence_required')
        # Full helper verifies live expanded static catalog, data, Storage and
        # restart again. A transaction that never committed cannot pass it.
        final=self.post_backup_and_receipt(approval,None,None)
        expected={**old,'schema_0412':m.registration(final)}
        m.need(state in (old,expected),'schema0412_recovery_state_changed')
        self.write_receipt(final);self.save_state(expected)
        self.write_journal({'format':1,'transition':'embedding-0412','phase':'registered','approval_sha256':m.digest(approval)})
        self.audit({'phase':'schema0412_registration_recovered','receipt_sha256':final['receipt_sha256']})
        return m.registration(final)


def main():
    m.need(os.geteuid()==0 and sys.platform=='linux','schema0412_root_linux_required')
    m.need(sys.argv[1:] in (['--apply'],['--register']),'schema0412_fixed_operation_required')
    runtime=RootMigrationRuntime()
    with existing_lock(e.STATE/'deployment.lock'):
        result=m.MigrationCoordinator(runtime).run() if sys.argv[1:]==['--apply'] else runtime.complete_registration()
    print(json.dumps({'ok':True,**result},sort_keys=True))


if __name__=='__main__':
    os.umask(0o077)
    try:main()
    except BaseException as error:
        code=error.code if isinstance(error,(m.TransitionError,e.Failure)) else 'schema0412_failed_details_redacted'
        print(json.dumps({'ok':False,'error':code}));sys.exit(1)
