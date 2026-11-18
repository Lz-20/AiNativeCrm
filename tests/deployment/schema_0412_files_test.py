"""Real root-owned fixture files, never production paths; explicit CI entry."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch
import uuid

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('schema0412_fixtures',HERE/'test_schema_0412.py')
fixtures=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixtures)
m=fixtures.m;cp=fixtures.catalog.m


class RootEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(os.geteuid(),0,'run explicitly as root only in the hosted CI fixture')
        self.base=Path('/root')/('schema0412-ci-'+uuid.uuid4().hex)
        self.base.mkdir(mode=0o700);self.state_dir=self.base/'state';self.state_dir.mkdir(mode=0o700)
        self.config=self.base/'config';self.config.mkdir(mode=0o700)
        self.directory=self.state_dir/'schema-0412';self.directory.mkdir(mode=0o700)
        (self.state_dir/'backups').mkdir(mode=0o700)
        self.paths=patch.multiple(m,STATE=self.state_dir,CONFIG=self.config,DIRECTORY=self.directory,
          APPROVAL=self.config/'schema-0412-approval.json',JOURNAL=self.directory/'journal.json');self.paths.start()
        self.before,self.after,self.topology,self.policy,self.state,self.approval,self.proof,self.context=fixtures.fixture()
        self.when=fixtures.catalog.NOW
        a,z,effective=m.catalog_context(self.approval,{'catalog-before.json':self.before,'catalog-after.json':self.after,
          'partition-before.json':self.topology,'partition-after.json':self.topology},self.policy,cp,self.when)
        before_proof=self.make_backup('before',self.before,self.policy)
        after_proof=self.make_backup('after',self.after,effective)
        values={'catalog-before.json':self.before,'catalog-after.json':self.after,'partition-before.json':self.topology,
          'partition-after.json':self.topology,'backup-before.json':before_proof,'backup-after.json':after_proof,
          'data-proof.json':{'unchanged':True,'new_tables_empty':True}}
        self.receipt={'format':1,'transition':'embedding-0412','approval_sha256':m.digest(self.approval),
          'files':m.evidence_inventory(values),'before_catalog_sha256':m.digest(self.before),'after_catalog_sha256':m.digest(self.after),
          'before_static_sha256':m.digest(a),'after_static_sha256':m.digest(z),'completed_at':self.when}
        for name,value in values.items():self.write(self.directory/name,value)
        self.write(m.APPROVAL,self.approval);self.write(self.directory/'receipt.json',self.receipt)
        self.write(m.JOURNAL,{'format':1,'transition':'embedding-0412','phase':'registered','approval_sha256':m.digest(self.approval)})
        context=m.validate_receipt(self.approval,self.receipt,values,self.policy,self.state,cp)
        self.state['schema_0412']=m.registration(context)
    def write(self,path,value):
        raw=(json.dumps(value,sort_keys=True,indent=2)+'\n').encode()
        path.write_bytes(raw);path.chmod(0o600);return {'file':path.name,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
    def make_backup(self,name,catalog,policy):
        directory=self.state_dir/'backups'/name;directory.mkdir(mode=0o700)
        files=[self.write(directory/'catalog-source.json',catalog),self.write(directory/'partition-source.json',self.topology)]
        observation=cp.evaluate(catalog,self.topology,policy,self.when,cp.SOURCE_CONTRACT)
        evidence={'restore_verified':True,'restart_verified':True,'storage_verified':True,'differences':0,
          'source_database_writes':False,'source_system_identifier':m.SYSTEM_ID,'source_container_id':m.CONTAINER_ID,
          'files':files,'started_at':self.when,'catalog_policy_sha256':m.digest(policy),'partition_validation':observation}
        receipt=self.write(directory/'evidence.json',evidence)
        return {'restore_verified':True,'differences':0,'source_system_identifier':m.SYSTEM_ID,'source_database':'postgres',
          'source_catalog_sha256':m.digest(catalog),'evidence_sha256':receipt['sha256'],'backup_directory':str(directory)}
    def tearDown(self):
        self.paths.stop()
        # Exact fixture prefix under /root; never a root production path.
        self.assertEqual(self.base.parent,Path('/root'));self.assertTrue(self.base.name.startswith('schema0412-ci-'))
        shutil.rmtree(self.base)
    def test_authenticated_complete_pack_is_accepted(self):
        context=m.read_context(self.state,self.policy,cp)
        self.assertEqual(context['database_schema'],m.TO_SCHEMA)
        self.assertEqual(self.state['approved_schema_sha256'],m.FROM_SCHEMA)
    def test_wrong_owner_permissions_symlink_hardlink_rejected(self):
        path=m.APPROVAL
        path.chmod(0o644)
        with self.assertRaises(m.TransitionError):m.read_context(self.state,self.policy,cp)
        path.chmod(0o600);os.chown(path,65534,65534)
        with self.assertRaises(m.TransitionError):m.read_context(self.state,self.policy,cp)
        os.chown(path,0,0)
        link=self.config/'extra';os.link(path,link)
        with self.assertRaises(m.TransitionError):m.read_context(self.state,self.policy,cp)
        link.unlink();original=path.read_bytes();path.unlink();link.write_bytes(original);link.chmod(0o600);path.symlink_to(link)
        with self.assertRaises(m.TransitionError):m.read_context(self.state,self.policy,cp)
    def test_replaced_catalog_or_receipt_or_registration_rejected(self):
        path=self.directory/'catalog-after.json';original=path.read_bytes()
        self.write(path,{**self.after,'unexpected':{}})
        with self.assertRaises(m.TransitionError):m.read_context(self.state,self.policy,cp)
        path.write_bytes(original)
        altered=copy.deepcopy(self.state);altered['schema_0412']['receipt_sha256']='0'*64
        with self.assertRaises(m.TransitionError):m.read_context(altered,self.policy,cp)
    def test_incomplete_journal_blocks_even_valid_receipts(self):
        for phase in ['applying','validated','sql_committed','registration_failed','transaction_failed_or_unknown']:
            self.write(m.JOURNAL,{'format':1,'transition':'embedding-0412','phase':phase,'approval_sha256':m.digest(self.approval)})
            with self.assertRaises(m.TransitionError):m.read_context(self.state,self.policy,cp)
    def test_restore_proof_tampering_is_rejected_not_just_boolean_trusted(self):
        proof=m.read(self.directory/'backup-after.json');directory=Path(proof['backup_directory'])
        raw=m.read(directory/'evidence.json');raw['restart_verified']=False
        self.write(directory/'evidence.json',raw)
        with self.assertRaises(m.TransitionError):m.read_context(self.state,self.policy,cp)
    def test_duplicate_approval_json_is_rejected(self):
        m.APPROVAL.write_bytes(b'{"format":1,"format":1}')
        with self.assertRaises(m.TransitionError):m.read_context(self.state,self.policy,cp)


if __name__=='__main__':unittest.main()
