"""Same-SHA independent CI and single-delivery admission. No VPS mutations."""
import argparse
import datetime as dt
import io
import json
import os
from pathlib import Path
import re
import subprocess
import time
import zipfile

REPOSITORY = "Lz-20/AiNativeCrm"
REQUIRED = {
    "ci.yml": {"verify-parte (1)", "verify-parte (2)", "verify", "invariants-alcance",
               "invariants-majors (15)", "invariants-majors (17)", "invariants"},
    "e2e.yml": {"e2e-alcance", "e2e", *{"e2e-parte (" + str(i) + ")" for i in range(1, 6)}},
    "perf.yml": {"build-and-size"},
    "rag-operations-isolated.yml": {"isolated-postgres (15)", "isolated-postgres (17)"},
    "release-safety-ci.yml": {"transport-and-browser"},
}
# On main every required JOB runs. Existing vendor-dependent TEST skips remain
# inside their successful jobs, not permission to skip a whole CI/matrix leg.
ALLOWED_JOB_SKIPS = {name: set() for name in REQUIRED}
BAD = {"failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure", "neutral"}
SHA = re.compile(r"[a-f0-9]{40}\Z")


def deploy_started(job):
    # GitHub can timestamp a skipped job even though none of its steps ran.
    return (job.get("name") == "deploy" and job.get("conclusion") != "skipped"
            and job.get("status") in ("in_progress", "completed") and bool(job.get("started_at")))


class Blocked(ValueError):
    pass


class Waiting(Blocked):
    pass


def need(value, code):
    if not value:
        raise Blocked(code)


def api(path, *, binary=False):
    # gh authenticates to its configured GitHub host; no token in argv/output.
    result = subprocess.run(["gh", "api", "repos/" + REPOSITORY + "/" + path], capture_output=True, timeout=45)
    need(result.returncode == 0, "github_read_failed")
    need(len(result.stdout) <= 4 * 1024 * 1024, "github_response_too_large")
    return result.stdout if binary else json.loads(result.stdout)


def paged(path, key, read=api):
    values = []
    for page in range(1, 11):
        rows = read(path + ("&" if "?" in path else "?") + f"per_page=100&page={page}")[key]
        need(isinstance(rows, list), "github_list_shape")
        values.extend(rows)
        if len(rows) < 100:
            return values
    raise Blocked("github_inventory_truncated")


def bound(run, sha, workflow):
    need(run.get("head_sha") == sha and run.get("head_branch") == "main"
         and run.get("head_repository", {}).get("full_name") == REPOSITORY
         and run.get("event") == "push" and run.get("path") == ".github/workflows/" + workflow,
         "quality_run_identity")
    need(run.get("run_attempt") == 1, "quality_rerun_requires_new_review")


def evaluate_quality(sha, inventories):
    need(isinstance(sha, str) and SHA.fullmatch(sha), "invalid_sha")
    receipts = {}
    waiting = []
    for workflow, required in REQUIRED.items():
        value = inventories.get(workflow)
        if not value:
            waiting.append(workflow + ":missing")
            continue
        run, jobs = value["run"], value["jobs"]
        bound(run, sha, workflow)
        seen = {}
        # Check a failed matrix leg immediately, BEFORE the aggregate finishes.
        for job in jobs:
            name = job.get("name")
            need(name not in seen, "duplicate_quality_job")
            seen[name] = job
            conclusion = job.get("conclusion")
            need(conclusion not in BAD, "quality_job_failed:" + workflow + ":" + str(name))
            if conclusion == "skipped":
                need(name in ALLOWED_JOB_SKIPS[workflow], "quality_job_unexpected_skip")
            if job.get("status") != "completed":
                waiting.append(workflow + ":" + str(name))
            elif conclusion != "success" and conclusion != "skipped":
                raise Blocked("quality_job_not_success")
        if required - set(seen):
            waiting.append(workflow + ":missing_jobs")
        need(run.get("conclusion") not in BAD and run.get("conclusion") != "skipped", "quality_workflow_failed")
        if run.get("status") != "completed":
            waiting.append(workflow + ":running")
        elif run.get("conclusion") != "success":
            raise Blocked("quality_workflow_not_success")
        receipts[workflow] = {"run_id": run["id"], "attempt": run["run_attempt"],
                             "head_sha": sha, "jobs": {name: seen[name].get("conclusion") for name in sorted(required & set(seen))}}
    if waiting:
        raise Waiting("quality_checks_pending_or_missing")
    return {"format": 1, "repository": REPOSITORY, "sha": sha, "workflows": receipts,
            "verified_at": dt.datetime.now(dt.timezone.utc).isoformat()}


def quality_snapshot(sha, read=api):
    inventories = {}
    for name in REQUIRED:
        runs = paged("actions/workflows/" + name + "/runs?head_sha=" + sha + "&event=push", "workflow_runs", read)
        if not runs:
            continue
        run = max(runs, key=lambda r: r["id"])
        inventories[name] = {"run": run, "jobs": paged(f"actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs", "jobs", read)}
    return inventories


def check_quality(sha, output, *, wait_seconds=0, read=api, sleep=time.sleep):
    started = time.monotonic()
    while True:
        need(read("git/ref/heads/main")["object"]["sha"] == sha, "main_moved")
        try:
            receipt = evaluate_quality(sha, quality_snapshot(sha, read))
            need(read("git/ref/heads/main")["object"]["sha"] == sha, "main_moved")
            Path(output).write_text(json.dumps(receipt, sort_keys=True, indent=2) + "\n", encoding="utf-8")
            return receipt
        except Waiting:
            if time.monotonic() - started >= wait_seconds:
                raise
            sleep(15)


def check_receipt(sha, receipt):
    need(receipt.get("format") == 1 and receipt.get("repository") == REPOSITORY and receipt.get("sha") == sha,
         "quality_receipt_identity")
    need(set(receipt.get("workflows", {})) == set(REQUIRED), "quality_receipt_incomplete")
    for name, required in REQUIRED.items():
        item = receipt["workflows"][name]
        need(item.get("head_sha") == sha and item.get("attempt") == 1 and type(item.get("run_id")) is int
             and set(item.get("jobs", {})) == required and all(v == "success" for v in item["jobs"].values()),
             "quality_receipt_not_accepted")


def terminal_result(run, read=api):
    """Only an actual original controller result can prove a transaction ID.

    A Runner cancellation / missing artifact never proves the remote stopped.
    Existing root status does not expose lost transaction/audit evidence.
    """
    artifacts = paged(f"actions/runs/{run['id']}/artifacts", "artifacts", read)
    candidates = [a for a in artifacts if a["name"] == "staging-result-" + str(run["id"]) and not a.get("expired")]
    if len(candidates) != 1:
        return None
    artifact = candidates[0]
    need(artifact["size_in_bytes"] <= 1024 * 1024, "delivery_artifact_size")
    raw = read(f"actions/artifacts/{artifact['id']}/zip", binary=True)
    import hashlib
    need("sha256:" + hashlib.sha256(raw).hexdigest() == artifact["digest"], "delivery_artifact_integrity")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if "deployment.json" not in archive.namelist():
            return None
        values = {}
        for name in ("deployment.json", "status-after.json", "delivery-journal.json"):
            if name not in archive.namelist():
                return None
            info = archive.getinfo(name)
            need(info.file_size <= 65536, "delivery_result_size")
            values[name] = json.loads(archive.read(info))
        result = values["deployment.json"]
        status = values["status-after.json"]
        journal = values["delivery-journal.json"]
    if not (run.get("conclusion") == "success" and result.get("ok") is True
            and result.get("sha") == run["head_sha"] and isinstance(result.get("transaction"), str)
            and re.fullmatch(r"\d{8}T\d{6}Z-[a-f0-9]{12}", result["transaction"])
            and isinstance(result.get("schema_sha256"), str)
            and re.fullmatch(r"[a-f0-9]{64}", result["schema_sha256"])
            and isinstance(result.get("images"), dict) and set(result["images"]) == {"app", "worker", "scheduler"}
            and all(isinstance(v, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", v) for v in result["images"].values())
            and status.get("ok") is True and status.get("recovery_required") is False
            and all(status.get(k) == result[k] for k in ("sha", "schema_sha256", "images"))
            and journal.get("phase") == "verified" and journal.get("run_id") == run["id"]
            and journal.get("transaction") == result["transaction"]):
        return None
    return {"run_id": run["id"], "sha": run["head_sha"], "transaction": result["transaction"]}


def original_results(run, read=api, *, manifest=False):
    """Legacy successful attempts may have a partial earlier-attempt artifact.
    Authenticate every candidate; only a unique complete result from the FINAL
    attempt interval can qualify. This is not latest-name/green-result guessing.
    """
    name = 'staging-release-' + run['head_sha'] if manifest else 'staging-result-' + str(run['id'])
    candidates = [a for a in paged(f"actions/runs/{run['id']}/artifacts", 'artifacts', read)
                  if a['name'] == name and not a.get('expired')]
    need(len(candidates) <= 5, 'legacy_artifact_ambiguity')
    results = []
    for a in candidates:
        def instant(value):return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        need(a['size_in_bytes'] <= 1024 * 1024, 'legacy_artifact_size')
        if not (instant(run['run_started_at']) <= instant(a['created_at']) <= instant(run['updated_at'])):
            continue
        raw = read(f"actions/artifacts/{a['id']}/zip", binary=True)
        import hashlib
        need('sha256:' + hashlib.sha256(raw).hexdigest() == a['digest'], 'legacy_artifact_integrity')
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            required = ['release.json'] if manifest else ['deployment.json', 'status-after.json']
            if not set(required) <= set(archive.namelist()):continue
            value = {}
            for item in required:
                need(archive.getinfo(item).file_size <= 65536, 'legacy_result_size')
                value[item] = json.loads(archive.read(item))
        results.append(value)
    need(len(results) == 1, 'legacy_complete_original_result_required')
    return results[0]


def reviewed_history(run, root, read=api):
    import staging_history as history
    history.require_review(root)
    if run['id'] == history.LEGACY_RUN:
        need(run['head_sha'] == history.AC8 and run.get('conclusion') == 'cancelled'
             and run.get('run_attempt') == 1, 'fixed_cancelled_incident_only')
        original = original_results(run, read, manifest=True)['release.json']
        deploy = root['incident']['deploy'];recovery = root['incident']['recovery']
        need(set(original) == {'operation', 'trigger', 'sha', 'schema_sha256', 'images'}
             and original['operation'] == 'deploy' and original['trigger'] == 'push'
             and all(original[k] == deploy['release'][k] for k in ('sha', 'schema_sha256', 'images')),
             'original_cancelled_request_root_mismatch')
        return {'run_id': run['id'], 'sha': run['head_sha'], 'transaction': history.DEPLOY,
                'recovery_transaction': history.RECOVERY, 'classification': 'failed_release_recovered_not_ci_accepted',
                'restored_sha': recovery['release']['sha'], 'evidence_sha256': root['evidence_sha256'],
                'human_review_sha256': root['review']['approval_sha256']}
    need(run['id'] < history.LEGACY_RUN and run.get('conclusion') == 'success', 'unreviewed_other_incident')
    original = original_results(run, read)
    result, status = original['deployment.json'], original['status-after.json']
    need(result.get('ok') is True and status.get('ok') is True and status.get('recovery_required') is False
         and result.get('sha') == run['head_sha'] and all(result.get(k) == status.get(k) for k in ('sha', 'schema_sha256', 'images')),
         'legacy_original_result_not_success')
    terminals = [r for r in root['prior_terminals'] if r['transaction'] == result.get('transaction')]
    need(len(terminals) == 1 and all(result.get(k) == terminals[0]['release'][k] for k in ('sha', 'schema_sha256', 'images')),
         'legacy_result_root_terminal_mismatch')
    return {'run_id': run['id'], 'sha': run['head_sha'], 'transaction': result['transaction'],
            'classification': 'original_success_and_pinned_root_terminal', 'evidence_sha256': root['evidence_sha256']}


def delivery_history(sha, current_run, read=api, *, inspect_root=None):
    """Inside single-VPS concurrency. CI precedes deployment; history may read
    the fixed root inspect endpoint but can never submit deploy/rollback.

    A deploy job that started is a conservative durable claim, even if its
    Runner died before uploading a journal. No automatic retry/rollback escape.
    """
    current = read(f"actions/runs/{current_run}")
    need(current.get("head_sha") == sha and current.get("run_attempt") == 1
         and current.get("path") == ".github/workflows/staging-release.yml"
         and current.get("head_branch") == "main"
         and current.get("head_repository", {}).get("full_name") == REPOSITORY
         and current.get("event") in ("push", "workflow_dispatch"), "delivery_rerun_or_sha")
    runs = paged("actions/workflows/staging-release.yml/runs?branch=main", "workflow_runs", read)
    receipts = []
    trusted_root = None
    for run in runs:
        if run["id"] == current_run:
            continue
        jobs = paged(f"actions/runs/{run['id']}/jobs?filter=all", "jobs", read)
        dispatched = any(deploy_started(j) for j in jobs)
        if not dispatched:
            continue
        need(run.get("path") == ".github/workflows/staging-release.yml"
             and run.get("head_branch") == "main"
             and run.get("head_repository", {}).get("full_name") == REPOSITORY
             and run.get("event") in ("push", "workflow_dispatch"), "prior_delivery_identity")
        need(run.get("head_sha") != sha, "same_sha_delivery_already_attempted")
        result = terminal_result(run, read)
        if result is None:
            # Only the explicitly reviewed legacy incident and ORIGINAL earlier
            # successful runs are eligible. Unknown future incidents stay shut.
            need(run['id'] == 44655810765 or (run['id'] < 44655810765 and run.get('conclusion') == 'success'),
                 'prior_remote_outcome_requires_operator_audit')
            if trusted_root is None:
                import staging_history
                try:
                    trusted_root = (inspect_root or staging_history.fetch)()
                    staging_history.require_review(trusted_root)
                except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
                    code = 'root_history_requires_independent_human_review' if isinstance(error, staging_history.HistoryError) and str(error) == 'root_history_requires_independent_human_review' else 'root_history_unknown_or_untrusted'
                    raise Blocked(code) from None
            result = reviewed_history(run, trusted_root, read)
        receipts.append(result)
    return receipts


def reconcile(request, before, status, result=None):
    """No mutations or guessed rollback. Unknown stays blocked for operator audit."""
    record = {"format": 1, "sha": request["sha"], "transaction": None, "allow_new_deploy": False,
              "automatic_rollback": False, "remote_current": status.get("sha") if status else None}
    if (result and result.get("ok") is True and result.get("sha") == request["sha"]
            and result.get("schema_sha256") == request["schema_sha256"] and result.get("images") == request["images"]
            and isinstance(result.get("transaction"), str)
            and re.fullmatch(r"\d{8}T\d{6}Z-[a-f0-9]{12}", result["transaction"])):
        record["transaction"] = result["transaction"]
    if not status or status.get("ok") is not True or status.get("recovery_required") is not False:
        record["outcome"] = "remote_unknown_or_running"
    elif (status.get("sha") == request["sha"] and status.get("images") == request["images"]
          and status.get("schema_sha256") == request["schema_sha256"]):
        record["outcome"] = "applied_with_receipt" if record["transaction"] else "applied_requires_operator_audit"
    elif before and status.get("sha") == before.get("sha") and status.get("images") == before.get("images"):
        record["outcome"] = "baseline_observed_requires_operator_audit"
    else:
        record["outcome"] = "remote_changed_requires_operator_audit"
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    quality = sub.add_parser("quality")
    quality.add_argument("--sha", required=True); quality.add_argument("--output", required=True)
    quality.add_argument("--wait-seconds", type=int, default=0)
    receipt = sub.add_parser("receipt")
    receipt.add_argument("--sha", required=True); receipt.add_argument("--input", required=True)
    history = sub.add_parser("history")
    history.add_argument("--sha", required=True); history.add_argument("--run-id", type=int, required=True)
    history.add_argument("--output", required=True)
    args = parser.parse_args()
    need(SHA.fullmatch(args.sha), "invalid_sha")
    if args.operation == "quality":
        check_quality(args.sha, args.output, wait_seconds=args.wait_seconds)
    elif args.operation == "receipt":
        check_receipt(args.sha, json.loads(Path(args.input).read_text(encoding="utf-8")))
    else:
        import staging_history
        Path(args.output).write_text(json.dumps(delivery_history(args.sha, args.run_id,
            inspect_root=lambda: staging_history.fetch(evidence_output='root-inspection.json')), indent=2), encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except (Blocked, OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        # Never relay gh stderr, signed artifact URLs or server/customer output.
        raise SystemExit("staging admission refused; inspect quality/reconciliation evidence")
