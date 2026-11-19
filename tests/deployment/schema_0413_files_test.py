"""Root-owned private fixture packs. Never production directories or approvals."""
import copy
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,HERE/file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
old=load('root_unchanged0412','schema_0412_files_test.py')
fixtures=load('root0413_fixture','test_schema_0413.py');m=fixtures.m;cp=fixtures.cp


class RootChainTests(unittest.TestCase):
    def setUp(self):
        self.old=old.RootEvidenceTests();self.old.setUp()
        self.directory=self.old.state_dir/'schema-0413';self.directory.mkdir(mode=0o700)
        self.paths=patch.multiple(m,STATE=self.old.state_dir,DIRECTORY=self.directory,
          APPROVAL=self.old.config/'schema-0413-approval.json',JOURNAL=self.directory/'journal.json');self.paths.start()
        self.legacy_path=patch.object(m.legacy,'STATE',self.old.state_dir);self.legacy_path.start()
        self.reader=patch.object(m.legacy,'read_context',lambda state,policy,cp:old.m.read_context(state,policy,cp));self.reader.start()
        before,after,topology,_,state,_,_=fixtures.fixture()
        self.state={**self.old.state,'current':state['current']}
        prior=old.m.read_context(self.state,self.old.policy,cp)
        self.plan=fixtures.approval(before,after,topology,prior,self.state)
        data_before={'public.contacts':{'count':1,'hash':'old'}}
        data_after={**data_before,**{'public.'+t:{'count':0,'hash':''} for t in m.TABLES}}
        values={'catalog-before.json':before,'catalog-after.json':after,'partition-before.json':topology,'partition-after.json':topology,
          'state-before.json':copy.deepcopy(self.state),'prior-registration.json':self.state['schema_0412'],
          'data-before.json':data_before,'data-after.json':data_after,'data-proof.json':m.verify_data(data_before,data_after)}
        a,z,policy=m.catalog_context(self.plan,values,prior,cp,self.old.when)
        values['backup-before.json']=self.old.make_backup('0413-before',before,prior['policy'])
        values['backup-after.json']=self.old.make_backup('0413-after',after,policy)
        self.receipt={'format':1,'transition':'rag-0413','approval_sha256':m.digest(self.plan),
          'prior_receipt_sha256':prior['receipt_sha256'],'files':m.evidence_inventory(values),
          'before_catalog_sha256':m.digest(before),'after_catalog_sha256':m.digest(after),
          'before_static_sha256':m.digest(a),'after_static_sha256':m.digest(z),'completed_at':self.old.when}
        for name,value in values.items():self.old.write(self.directory/name,value)
        self.old.write(m.APPROVAL,self.plan);self.old.write(self.directory/'receipt.json',self.receipt)
        self.old.write(m.JOURNAL,{'format':1,'transition':'rag-0413','phase':'registered','approval_sha256':m.digest(self.plan)})
        context=m.validate_receipt(self.plan,self.receipt,values,prior,self.state,cp)
        self.state['schema_0413']=m.registration(context)
    def tearDown(self):
        self.reader.stop();self.legacy_path.stop();self.paths.stop();self.old.tearDown()
    def test_full_prior_and_new_root_pack_reauthenticated(self):
        old_registration=copy.deepcopy(self.state['schema_0412']);anchors=(self.state['approved_schema_sha256'],self.state['approved_catalog_sha256'])
        self.assertEqual(m.read_context(self.state,self.old.policy,cp)['database_schema'],m.TO_SCHEMA)
        self.assertEqual(old_registration,self.state['schema_0412']);self.assertEqual(anchors,(self.state['approved_schema_sha256'],self.state['approved_catalog_sha256']))
    def test_prior_0412_receipt_tamper_invalidates_new_chain(self):
        path=self.old.directory/'receipt.json';self.old.write(path,{**old.m.read(path),'completed_at':'2000-01-01T00:00:00+00:00'})
        with self.assertRaises(ValueError):m.read_context(self.state,self.old.policy,cp)
    def test_new_owner_mode_hardlink_and_symlink_rejected(self):
        path=m.APPROVAL;path.chmod(0o644)
        with self.assertRaises(ValueError):m.read_context(self.state,self.old.policy,cp)
        path.chmod(0o600);os.chown(path,65534,65534)
        with self.assertRaises(ValueError):m.read_context(self.state,self.old.policy,cp)
        os.chown(path,0,0);link=self.old.config/'link413';os.link(path,link)
        with self.assertRaises(ValueError):m.read_context(self.state,self.old.policy,cp)
        link.unlink();raw=path.read_bytes();path.unlink();link.write_bytes(raw);link.chmod(0o600);path.symlink_to(link)
        with self.assertRaises(ValueError):m.read_context(self.state,self.old.policy,cp)
    def test_nonregistered_phase_blocks_business_and_wrong_registration_rejected(self):
        for phase in ('applying','validated','transaction_failed_or_unknown','sql_committed','registration_failed'):
            self.old.write(m.JOURNAL,{'format':1,'transition':'rag-0413','phase':phase,'approval_sha256':m.digest(self.plan)})
            with self.assertRaises(ValueError):m.read_context(self.state,self.old.policy,cp)
    def test_data_is_recomputed_not_boolean_trusted(self):
        values={name:m.read(self.directory/name) for name in m.EVIDENCE_FILES}
        values['data-after.json']['public.contacts']['hash']='changed'
        receipt={**self.receipt,'files':m.evidence_inventory(values)}
        prior=old.m.read_context(self.state,self.old.policy,cp)
        with self.assertRaises(ValueError):m.validate_receipt(self.plan,receipt,values,prior,self.state,cp)
    def test_new_restore_evidence_and_catalog_receipt_tamper_rejected(self):
        proof=m.read(self.directory/'backup-after.json');path=Path(proof['backup_directory'])/'evidence.json'
        self.old.write(path,{**m.read(path),'restart_verified':False})
        with self.assertRaises(ValueError):m.read_context(self.state,self.old.policy,cp)


if __name__=='__main__':unittest.main()
