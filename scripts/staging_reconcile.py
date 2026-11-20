"""Independent observer. Fixed STATUS/INSPECT only; never deploy, rollback or kill."""
import argparse
import io
import json
import os
from pathlib import Path
import zipfile
import hashlib
import staging_history

import staging_release_guard as gate
from staging_delivery import client, save


def artifact_files(run_id, name, allowed, read=gate.api):
    candidates = [a for a in gate.paged(f"actions/runs/{run_id}/artifacts", "artifacts", read)
                  if a["name"] == name and not a.get("expired")]
    if len(candidates) != 1:
        return {}
    a = candidates[0]
    gate.need(a["size_in_bytes"] <= 1024 * 1024, "reconcile_artifact_size")
    raw = read(f"actions/artifacts/{a['id']}/zip", binary=True)
    gate.need("sha256:" + hashlib.sha256(raw).hexdigest() == a["digest"], "reconcile_artifact_hash")
    files = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for name in allowed:
            if name in archive.namelist():
                entry = archive.getinfo(name)
                gate.need(entry.file_size <= 65536, "reconcile_file_size")
                files[name] = json.loads(archive.read(entry))
    return files


def observe(run_id, output, *, read=gate.api, transport=client.ssh_request):
    run = read(f"actions/runs/{run_id}")
    gate.need(run.get("path") == ".github/workflows/staging-release.yml" and run.get("head_branch") == "main"
              and run.get("head_repository", {}).get("full_name") == gate.REPOSITORY
              and run.get("event") in ("push", "workflow_dispatch") and run.get("status") == "completed"
              and gate.SHA.fullmatch(run.get("head_sha", "")), "reconciliation_run_identity")
    jobs = gate.paged(f"actions/runs/{run_id}/jobs?filter=all", "jobs", read)
    started = any(gate.deploy_started(j) for j in jobs)
    if not started:
        result = {"format": 1, "run_id": run_id, "sha": run["head_sha"], "outcome": "no_deploy_job_started",
                  "transaction": None, "remote_query_sent": False, "automatic_rollback": False}
        save(output, result)
        return result
    files = artifact_files(run_id, "staging-result-" + str(run_id),
                           {"status-before.json", "status-after.json", "deployment.json", "delivery-journal.json"}, read)
    release = artifact_files(run_id, "staging-release-" + run["head_sha"], {"release.json"}, read).get("release.json")
    result = {"format": 1, "run_id": run_id, "sha": run["head_sha"], "workflow_conclusion": run["conclusion"],
              "outcome": "operator_reconciliation_required", "transaction": None, "allow_new_deploy": False,
              "remote_query_sent": False, "automatic_rollback": False}
    response = files.get("deployment.json")
    if release:
        from staging_delivery import validate_request
        validate_request(release)
        gate.need(release["sha"] == run["head_sha"], "reconcile_release_sha")
        base = Path(output).parent
        request = base / "reconcile-status-request.json"
        save(request, {"operation": "status"})
        status = None
        try:
            result["remote_query_sent"] = True
            transport(request, base / "remote-status.json", timeout_seconds=25)
            status = json.loads((base / "remote-status.json").read_text(encoding="utf-8"))
        except (OSError, ValueError, client.subprocess.SubprocessError):
            pass
        result.update(gate.reconcile(release, files.get("status-before.json"), status, response))
        # Even a known applied result from a cancelled/failed workflow is an
        # incident. Only original successful delivery + successful workflow can
        # be accepted; no inferred previous or automatic recovery submission.
        if result["outcome"] == "applied_with_receipt" and run["conclusion"] == "success":
            result["outcome"] = "verified_original_delivery"
        if result['outcome'] != 'verified_original_delivery':
            selector = staging_history.DEPLOY if run_id == staging_history.LEGACY_RUN else result.get('transaction') or 'latest'
            try:
                proof = staging_history.fetch(transport=transport, transaction=selector,
                    evidence_output=Path(output).parent / 'root-inspection.json')
                result['root_inspection_status'] = 'authenticated'
                result['root_evidence_sha256'] = proof['evidence_sha256']
                root_record = proof['record']
                if all(root_record['release'][k] == release[k] for k in ('sha', 'schema_sha256', 'images')):
                    result['transaction'] = root_record['transaction']
                    result['outcome'] = 'root_transaction_confirmed_actions_evidence_requires_review'
                if run_id == staging_history.LEGACY_RUN:
                    # This classifies the FAILED release as safely recovered;
                    # never relabel cancelled Actions as a successful release.
                    gate.need(all(proof['incident']['deploy']['release'][k] == release[k]
                                  for k in ('sha', 'schema_sha256', 'images')), 'historical_root_request_mismatch')
                    result.update(transaction=staging_history.DEPLOY, recovery_transaction=staging_history.RECOVERY,
                        outcome='historical_chain_authenticated_human_review_required')
                    if proof['review']['status'] == 'reviewed':
                        result['outcome'] = 'historical_failure_recovered_after_root_review'
                result['allow_new_deploy'] = False
            except (OSError, ValueError, KeyError, TypeError, client.subprocess.SubprocessError):
                result['root_inspection_status'] = 'unknown_or_busy_or_unavailable'
    save(output, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", type=int, required=True); parser.add_argument("--output", required=True)
    args = parser.parse_args()
    gate.need(os.environ.get("GITHUB_REPOSITORY") == gate.REPOSITORY, "trusted_observer_only")
    value = observe(args.run_id, args.output)
    if value["outcome"] not in ("no_deploy_job_started", "verified_original_delivery", "historical_failure_recovered_after_root_review"):
        raise SystemExit("remote outcome needs protected operator audit; no new deploy or guessed rollback")


if __name__ == "__main__":
    try:
        main()
    except (gate.Blocked, OSError, ValueError, KeyError, TypeError):
        raise SystemExit("reconciliation refused; retain evidence and request operator review")
