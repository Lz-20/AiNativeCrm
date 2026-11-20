"""Single fixed-protocol delivery; client cancellation never means remote cancellation."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import tempfile

import staging_release_guard as gate

spec = importlib.util.spec_from_file_location("staging_fixed_client", Path(__file__).with_name("staging-ci.py"))
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


def save(path, value):
    path = Path(path)
    raw = (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        name = stream.name
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    os.replace(name, path)


def validate_request(request):
    gate.need(set(request) == {"operation", "trigger", "sha", "schema_sha256", "images"}
              and request["operation"] == "deploy" and request["trigger"] in client.TRIGGERS,
              "fixed_deploy_only")
    client.require(request["sha"], client.SHA, "sha")
    client.require(request["schema_sha256"], client.HASH, "schema")
    gate.need(set(request["images"]) == set(client.SERVICES), "three_images_required")
    for value in request["images"].values():
        client.require(value, client.DIGEST, "digest")


def deliver(request, quality, run_id, journal, *, read=gate.api, transport=client.ssh_request):
    validate_request(request)
    gate.check_receipt(request["sha"], quality)
    gate.need(not Path(journal).exists(), "delivery_already_claimed")
    # Both the live independent CI and the prior transaction history precede
    # even the status probe, never merely a copied old green artifact.
    gate.check_quality(request["sha"], str(journal) + ".quality.json", read=read)
    history = gate.delivery_history(request["sha"], run_id, read)
    record = {"format": 1, "sha": request["sha"], "request": request, "run_id": run_id,
              "phase": "prepared", "transaction": None, "before": None,
              "automatic_retry": False, "automatic_rollback": False, "prior_receipts": history}
    # O_EXCL is the local one-shot claim. GitHub deploy-job history is the durable
    # conservative claim if cancellation kills the Runner before artifact upload.
    fd = os.open(journal, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(record, stream); stream.flush(); os.fsync(stream.fileno())
    dispatched = False
    result = None
    base = Path(journal).parent
    status_request = base / "status-request.json"
    save(status_request, {"operation": "status"})
    try:
        transport(status_request, base / "status-before.json", timeout_seconds=30)
        before = json.loads((base / "status-before.json").read_text(encoding="utf-8"))
        client.check_status(before, request["schema_sha256"], request["trigger"])
        record["before"] = before
        # Recheck after the server's read-only status. Later upstream changes
        # are an incident to reconcile, never evidence of remote cancellation.
        gate.check_quality(request["sha"], str(journal) + ".quality.json", read=read)
        record["phase"] = "dispatching_unknown_until_receipted"
        save(journal, record)
        payload = base / "dispatch-request.json"
        save(payload, request)
        dispatched = True
        transport(payload, base / "deployment.json")  # EXACTLY ONCE, no retry
        result = json.loads((base / "deployment.json").read_text(encoding="utf-8"))
        gate.need(result.get("ok") is True and result.get("sha") == request["sha"]
                  and result.get("images") == request["images"] and result.get("schema_sha256") == request["schema_sha256"]
                  and isinstance(result.get("transaction"), str)
                  and gate.re.fullmatch(r"\d{8}T\d{6}Z-[a-f0-9]{12}", result["transaction"]), "controller_receipt_required")
        record.update(transaction=result["transaction"], phase="controller_returned")
        save(journal, record)
        transport(status_request, base / "status-after.json", timeout_seconds=30)
        status = json.loads((base / "status-after.json").read_text(encoding="utf-8"))
        client.verify_release(request, status)
        # A quality rerun/cancellation after acceptance is an incident, never a
        # reason to guess previous or silently call deploy again.
        gate.check_quality(request["sha"], str(journal) + ".quality.json", read=read)
        record.update(phase="verified", reconciliation=gate.reconcile(request, before, status, result))
        save(journal, record)
        return record
    except BaseException:
        record["phase"] = "remote_outcome_unknown" if dispatched else "blocked_before_dispatch"
        save(journal, record)
        if dispatched:
            status = None
            try:
                transport(status_request, base / "status-reconcile.json", timeout_seconds=25)
                status = json.loads((base / "status-reconcile.json").read_text(encoding="utf-8"))
            except (Exception, KeyboardInterrupt):
                pass
            record["reconciliation"] = gate.reconcile(request, record["before"], status, result)
            record["phase"] = "operator_reconciliation_required"
            save(journal, record)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True); parser.add_argument("--quality", required=True)
    parser.add_argument("--run-id", required=True, type=int); parser.add_argument("--journal", required=True)
    args = parser.parse_args()
    gate.need(os.environ.get("GITHUB_REPOSITORY") == gate.REPOSITORY
              and os.environ.get("GITHUB_REF") == "refs/heads/main", "trusted_main_runner_only")
    def interrupted(_number, _frame):
        raise KeyboardInterrupt("runner_cancelled_remote_not_cancelled")
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, interrupted)
    deliver(json.loads(Path(args.request).read_text(encoding="utf-8")),
            json.loads(Path(args.quality).read_text(encoding="utf-8")), args.run_id, args.journal)


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt):
        raise SystemExit("delivery stopped; inspect journal and independent reconciliation, never retry blindly")
