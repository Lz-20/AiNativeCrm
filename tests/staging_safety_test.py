"""Synthetic GitHub + fixed SSH transport. Never contacts GitHub/VPS/models."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import hashlib
import io
import zipfile
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import staging_release_guard as g
import staging_delivery as d
import staging_reconcile as observer

SHA = "a" * 40
SCHEMA = "b" * 64
IMAGES = {s: "sha256:" + c * 64 for s, c in zip(("app", "worker", "scheduler"), "123")}
REQUEST = {"operation": "deploy", "trigger": "push", "sha": SHA, "schema_sha256": SCHEMA, "images": IMAGES}
BEFORE = {"ok": True, "sha": "c" * 40, "schema_sha256": SCHEMA,
          "images": {s: "sha256:" + "f" * 64 for s in IMAGES}, "rollback_verified": True,
          "paused": False, "auto_deploy_enabled": True, "recovery_required": False}
AFTER = {**BEFORE, "sha": SHA, "images": IMAGES}
RESULT = {**REQUEST, "ok": True, "transaction": "20261120T021305Z-128754217ad3"}


def inventories():
    out = {}
    for i, (name, jobs) in enumerate(g.REQUIRED.items(), 1):
        out[name] = {"run": {"id": i, "head_sha": SHA, "head_branch": "main", "run_attempt": 1,
                    "head_repository": {"full_name": g.REPOSITORY}, "event": "push",
                    "path": ".github/workflows/" + name, "status": "completed", "conclusion": "success"},
                    "jobs": [{"name": j, "status": "completed", "conclusion": "success"} for j in sorted(jobs)]}
    return out


class Github:
    def __init__(self):
        self.values = inventories()
        self.prior = []
        self.prior_jobs = {}
        self.attempt = 1
    def __call__(self, path, **kwargs):
        if path == "git/ref/heads/main": return {"object": {"sha": SHA}}
        if path == "actions/runs/99": return {"head_sha": SHA, "run_attempt": self.attempt,
            "path":".github/workflows/staging-release.yml","head_branch":"main",
            "head_repository":{"full_name":g.REPOSITORY},"event":"push"}
        if path.startswith("actions/workflows/staging-release.yml/runs"):
            return {"workflow_runs": self.prior}
        for name, value in self.values.items():
            if path.startswith("actions/workflows/" + name + "/runs"):
                return {"workflow_runs": [value["run"]]}
            if path.startswith(f"actions/runs/{value['run']['id']}/attempts/1/jobs"):
                return {"jobs": value["jobs"]}
        for key, value in self.prior_jobs.items():
            if path.startswith(f"actions/runs/{key}/jobs"): return {"jobs": value}
            if path.startswith(f"actions/runs/{key}/artifacts"): return {"artifacts": []}
        raise AssertionError("unexpected fixture API: " + path)


class Quality(unittest.TestCase):
    def test_every_same_sha_job_succeeds(self):
        r = g.evaluate_quality(SHA, inventories());g.check_receipt(SHA, r)
        self.assertEqual(set(r["workflows"]), set(g.REQUIRED))
    def test_actual_incident_failed_fifth_leg_even_before_workflow_aggregates(self):
        value = inventories();value["e2e.yml"]["run"].update(status="in_progress", conclusion=None)
        next(j for j in value["e2e.yml"]["jobs"] if j["name"] == "e2e-parte (5)")["conclusion"] = "failure"
        with self.assertRaisesRegex(g.Blocked, "quality_job_failed"):
            g.evaluate_quality(SHA, value)
    def test_pending_cancelled_timeout_missing_wrong_sha_and_unexpected_skip_refuse(self):
        for field, replacement in [("status", "in_progress"), ("conclusion", "cancelled"),
                                   ("conclusion", "timed_out"), ("conclusion", "skipped")]:
            value = inventories();value["ci.yml"]["jobs"][0][field] = replacement
            with self.assertRaises(g.Blocked):g.evaluate_quality(SHA, value)
        for kind in ("missing_workflow", "missing_job", "wrong_sha", "old_attempt"):
            value = inventories()
            if kind == "missing_workflow":del value["e2e.yml"]
            elif kind == "missing_job":value["e2e.yml"]["jobs"].pop()
            elif kind == "wrong_sha":value["e2e.yml"]["run"]["head_sha"] = "d" * 40
            else:value["e2e.yml"]["run"]["run_attempt"] = 2
            with self.assertRaises(g.Blocked):g.evaluate_quality(SHA, value)
    def test_missing_wait_never_returns_authorization(self):
        gh = Github();gh.values["e2e.yml"]["jobs"] = []
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(g.Waiting):g.check_quality(SHA, Path(tmp)/"quality.json", read=gh)
            self.assertFalse((Path(tmp)/"quality.json").exists())


class Delivery(unittest.TestCase):
    def run_delivery(self, mode="ok", gh=None):
        gh = gh or Github();calls = [];result = None;error = None
        def transport(request, output, **kwargs):
            value = json.loads(Path(request).read_text());calls.append(value)
            if value["operation"] == "deploy":
                if mode == "ssh_lost": raise OSError("synthetic transport loss, remote may run")
                if mode == "cancel_after_accept": raise KeyboardInterrupt("synthetic Runner cancel")
                if mode == "upstream_failed_after_accept":
                    gh.values["e2e.yml"]["jobs"][0]["conclusion"] = "failure"
                Path(output).write_text(json.dumps(RESULT))
            else:
                if len(calls) > 1 and mode == "ssh_lost":raise ValueError("remote lock busy/unknown")
                Path(output).write_text(json.dumps(AFTER if len(calls)>1 else BEFORE))
        with tempfile.TemporaryDirectory() as tmp:
            journal = Path(tmp)/"delivery-journal.json"
            try:result = d.deliver(REQUEST, g.evaluate_quality(SHA, inventories()), 99, journal, read=gh, transport=transport)
            except BaseException as exc:error = exc
            record = json.loads(journal.read_text()) if journal.exists() else None
        return calls, result, record, error
    def test_all_ci_good_one_real_transport_dispatch_and_transaction_saved(self):
        calls, result, record, error = self.run_delivery()
        self.assertIsNone(error);self.assertEqual(sum(c["operation"]=="deploy" for c in calls),1)
        self.assertEqual(result["phase"], "verified");self.assertEqual(record["transaction"], RESULT["transaction"])
    def test_internal_e2e_green_but_independent_failed_sends_zero_deploys(self):
        gh=Github();gh.values["e2e.yml"]["jobs"][-1]["conclusion"]="failure"
        calls, _, _, error=self.run_delivery(gh=gh)
        self.assertIsInstance(error,g.Blocked);self.assertEqual(calls,[])
    def test_pending_missing_or_cancelled_send_zero_requests(self):
        for mode in ("running","missing","cancelled"):
            gh=Github()
            if mode=="running":gh.values["e2e.yml"]["run"]["status"]="in_progress"
            elif mode=="missing":gh.values["e2e.yml"]["jobs"].pop()
            else:gh.values["e2e.yml"]["jobs"][0]["conclusion"]="cancelled"
            calls,_,_,error=self.run_delivery(gh=gh);self.assertIsInstance(error,g.Blocked);self.assertEqual(calls,[])
    def test_cancel_before_remote_acceptance_does_not_dispatch(self):
        gh=Github()
        def cancelled_api(*args,**kwargs):raise KeyboardInterrupt("synthetic cancellation during quality")
        with tempfile.TemporaryDirectory() as tmp:
            calls=[]
            with self.assertRaises(KeyboardInterrupt):d.deliver(REQUEST,g.evaluate_quality(SHA,inventories()),99,Path(tmp)/"j",read=cancelled_api,transport=lambda *a,**k:calls.append(a))
            self.assertEqual(calls,[])
    def test_cancel_after_acceptance_preserves_unknown_and_never_retries_or_rolls_back(self):
        calls,_,record,error=self.run_delivery("cancel_after_accept")
        self.assertIsInstance(error,KeyboardInterrupt);self.assertEqual(sum(c["operation"]=="deploy" for c in calls),1)
        self.assertFalse(any(c["operation"]=="rollback" for c in calls));self.assertIsNone(record["transaction"])
        self.assertEqual(record["phase"],"operator_reconciliation_required")
        self.assertEqual(record["reconciliation"]["outcome"],"applied_requires_operator_audit")
    def test_ssh_disconnect_remote_running_is_not_cancelled_and_never_resubmitted(self):
        calls,_,record,error=self.run_delivery("ssh_lost")
        self.assertIsInstance(error,OSError);self.assertEqual(sum(c["operation"]=="deploy" for c in calls),1)
        self.assertEqual(record["reconciliation"]["outcome"],"remote_unknown_or_running")
    def test_remote_success_but_upstream_later_failed_requires_operator_no_blind_previous(self):
        calls,_,record,error=self.run_delivery("upstream_failed_after_accept")
        self.assertIsInstance(error,g.Blocked);self.assertEqual(record["transaction"],RESULT["transaction"])
        self.assertEqual(record["phase"],"operator_reconciliation_required")
        self.assertFalse(any(c["operation"]=="rollback" for c in calls))
    def test_concurrent_or_restarted_same_sha_is_refused_before_transport(self):
        gh=Github();gh.prior=[{"id":88,"head_sha":SHA}];gh.prior_jobs[88]=[{"name":"deploy","status":"completed","started_at":"2026-11-20T01:00:00Z"}]
        calls,_,_,error=self.run_delivery(gh=gh);self.assertIsInstance(error,g.Blocked);self.assertEqual(calls,[])
    def test_previous_run_missing_actions_result_blocks_new_sha(self):
        gh=Github();gh.prior=[{"id":88,"head_sha":"d"*40,"path":".github/workflows/staging-release.yml",
            "head_branch":"main","head_repository":{"full_name":g.REPOSITORY},"event":"push"}];gh.prior_jobs[88]=[{"name":"deploy","status":"completed","started_at":"2026-11-20T01:00:00Z"}]
        calls,_,_,error=self.run_delivery(gh=gh);self.assertIsInstance(error,g.Blocked);self.assertEqual(calls,[])
    def test_previous_unaccepted_version_never_becomes_an_automatic_rollback(self):
        for status in [None,{**BEFORE,"previous":"unaccepted"},AFTER,{**AFTER,"recovery_required":True}]:
            r=g.reconcile(REQUEST,BEFORE,status)
            self.assertFalse(r["allow_new_deploy"]);self.assertFalse(r["automatic_rollback"]);self.assertIsNone(r["transaction"])
    def test_original_entry_rejects_rollback_payload(self):
        with self.assertRaises(g.Blocked):d.validate_request({"operation":"rollback"})
    def test_skipped_jobs_with_github_timestamps_are_not_delivery_claims(self):
        gh=Github();gh.prior=[{"id":88,"head_sha":"d"*40}]
        gh.prior_jobs[88]=[{"name":"deploy","status":"completed","conclusion":"skipped","started_at":"2026-11-20T01:00:00Z"}]
        calls, result, _, error=self.run_delivery(gh=gh)
        self.assertIsNone(error);self.assertEqual(result["phase"],"verified")
        self.assertEqual(sum(c["operation"]=="deploy" for c in calls),1)
    def test_wrong_sha_receipt_never_supplies_a_transaction_id(self):
        result=g.reconcile(REQUEST,BEFORE,AFTER,{**RESULT,"sha":"d"*40})
        self.assertIsNone(result["transaction"]);self.assertFalse(result["allow_new_deploy"])


class OriginalReceipt(unittest.TestCase):
    def test_history_requires_successful_bound_final_status_and_verified_journal(self):
        run={"id":88,"head_sha":SHA,"conclusion":"success"}
        for invalid in (None,"missing_journal","wrong_images","recovery_required","unverified","wrong_transaction"):
            files={"deployment.json":copy.deepcopy(RESULT),"status-after.json":copy.deepcopy(AFTER),
                   "delivery-journal.json":{"phase":"verified","run_id":88,"transaction":RESULT["transaction"]}}
            if invalid=="missing_journal":del files["delivery-journal.json"]
            elif invalid=="wrong_images":files["status-after.json"]["images"]["app"]="sha256:"+"f"*64
            elif invalid=="recovery_required":files["status-after.json"]["recovery_required"]=True
            elif invalid=="unverified":files["delivery-journal.json"]["phase"]="controller_returned"
            elif invalid=="wrong_transaction":files["delivery-journal.json"]["transaction"]="20261120T021305Z-000000000000"
            stream=io.BytesIO()
            with zipfile.ZipFile(stream,"w") as archive:
                for name,value in files.items():archive.writestr(name,json.dumps(value))
            raw=stream.getvalue()
            def read(path,**kwargs):
                if path.endswith("/zip"):return raw
                return {"artifacts":[{"id":7,"name":"staging-result-88","expired":False,"size_in_bytes":len(raw),"digest":"sha256:"+hashlib.sha256(raw).hexdigest()}]}
            result=g.terminal_result(run,read)
            if invalid is None:self.assertEqual(result["transaction"],RESULT["transaction"])
            else:self.assertIsNone(result,invalid)


class Observer(unittest.TestCase):
    def test_no_deploy_job_started_sends_no_ssh(self):
        calls=[]
        def read(path,**kwargs):
            if path=="actions/runs/88":return {"id":88,"path":".github/workflows/staging-release.yml","head_branch":"main","head_repository":{"full_name":g.REPOSITORY},"event":"push","status":"completed","head_sha":SHA}
            return {"jobs":[{"name":"deploy","status":"completed","conclusion":"skipped","started_at":None}]}
        with tempfile.TemporaryDirectory() as tmp:
            v=observer.observe(88,Path(tmp)/"result",read=read,transport=lambda *a,**k:calls.append(a))
        self.assertEqual(v["outcome"],"no_deploy_job_started");self.assertEqual(calls,[])
    def test_untrusted_workflow_run_cannot_use_vps_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(g.Blocked):observer.observe(88,Path(tmp)/"result",read=lambda *a,**k:{"head_sha":SHA})
    def test_completed_remote_with_actions_result_lost_is_status_only_and_not_accepted(self):
        for busy in [False,True]:
            payloads={}
            for id,files in [(1,{"release.json":REQUEST}),(2,{"status-before.json":BEFORE})]:
                stream=io.BytesIO()
                with zipfile.ZipFile(stream,'w') as z:
                    for name,value in files.items():z.writestr(name,json.dumps(value))
                payloads[id]=stream.getvalue()
            def read(path,**kwargs):
                if path=="actions/runs/88":return {"id":88,"path":".github/workflows/staging-release.yml","head_branch":"main","head_repository":{"full_name":g.REPOSITORY},"event":"push","status":"completed","head_sha":SHA,"conclusion":"cancelled"}
                if "/jobs?" in path:return {"jobs":[{"name":"deploy","status":"completed","started_at":"2026-11-20T01:00:00Z","conclusion":"cancelled"}]}
                if "/artifacts?" in path:return {"artifacts":[{"id":id,"name":("staging-release-"+SHA if id==1 else "staging-result-88"),"expired":False,"size_in_bytes":len(raw),"digest":"sha256:"+hashlib.sha256(raw).hexdigest()} for id,raw in payloads.items()]}
                if path.endswith('/zip'):return payloads[int(path.split('/')[-2])]
                raise AssertionError(path)
            calls=[]
            def transport(request,output,**kwargs):
                calls.append(json.loads(Path(request).read_text()))
                if busy:raise ValueError('legacy root deployment lock is busy')
                Path(output).write_text(json.dumps(AFTER))
            with tempfile.TemporaryDirectory() as tmp:value=observer.observe(88,Path(tmp)/'reconciliation.json',read=read,transport=transport)
            self.assertEqual(calls,[{"operation":"status"}]);self.assertIsNone(value['transaction'])
            self.assertFalse(value['allow_new_deploy']);self.assertFalse(value['automatic_rollback'])
            self.assertEqual(value['outcome'],'remote_unknown_or_running' if busy else 'applied_requires_operator_audit')


class ActualLocalTransport(unittest.TestCase):
    def test_disconnected_client_does_not_stop_the_server_transaction(self):
        accepted=threading.Event();finish=threading.Event();applied=threading.Event();requests=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                accepted.set();finish.wait(3);applied.set()
                try:
                    raw=json.dumps(RESULT).encode();self.send_response(200);self.end_headers();self.wfile.write(raw)
                except (BrokenPipeError,ConnectionResetError):pass
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        calls=[]
        def transport(request,output,**kwargs):
            value=json.loads(Path(request).read_text());calls.append(value)
            if value['operation']=='deploy':
                q=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/deploy',data=json.dumps(value).encode(),method='POST')
                urllib.request.urlopen(q,timeout=0.15)
            elif accepted.is_set():raise ValueError('remote transaction still holds the deployment lock')
            else:Path(output).write_text(json.dumps(BEFORE))
        try:
            with tempfile.TemporaryDirectory() as tmp:
                journal=Path(tmp)/'journal.json'
                with self.assertRaises((TimeoutError,OSError)):d.deliver(REQUEST,g.evaluate_quality(SHA,inventories()),99,journal,read=Github(),transport=transport)
                self.assertTrue(accepted.is_set());self.assertFalse(applied.is_set())
                record=json.loads(journal.read_text());self.assertEqual(record['reconciliation']['outcome'],'remote_unknown_or_running')
                finish.set();self.assertTrue(applied.wait(2))
                self.assertEqual(requests,[REQUEST]);self.assertEqual(sum(c['operation']=='deploy' for c in calls),1)
                self.assertFalse(any(c['operation']=='rollback' for c in calls))
        finally:
            finish.set();server.shutdown();server.server_close();thread.join(2)


if __name__=="__main__":unittest.main()
