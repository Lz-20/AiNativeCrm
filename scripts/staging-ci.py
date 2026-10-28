#!/usr/bin/env python3
"""Small, credential-free release protocol shared by the staging Actions jobs.

The server independently verifies Git ancestry, this complete schema tree, image
labels, backup restore evidence and its root-owned policy before touching Docker.
This client never sends environment files, database credentials or shell commands.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

SERVICES = ("app", "worker", "scheduler")
SHA = re.compile(r"[0-9a-f]{40}\Z")
HASH = re.compile(r"[0-9a-f]{64}\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
TRIGGERS = ("workflow_dispatch", "push")


def require(value, pattern, name):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError(f"Invalid {name}")
    return value


def schema_fingerprint(sha, directory=None):
    require(sha, SHA, "commit SHA")
    tree = subprocess.check_output([
        "git", "ls-tree", "-r", "-z", "--full-tree", sha,
        "--", "supabase", "lib/database.types.ts"
    ], cwd=directory, stderr=subprocess.DEVNULL)
    if not tree:
        raise ValueError("Empty schema tree")
    return hashlib.sha256(tree).hexdigest()


def make_manifest(directory, sha, schema, trigger):
    require(sha, SHA, "commit SHA")
    require(schema, HASH, "schema fingerprint")
    if trigger not in TRIGGERS:
        raise ValueError("Unsupported release trigger")
    images = {}
    for path in sorted(Path(directory).glob("*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        if set(record) != {"service", "sha", "schema_sha256", "digest"}:
            raise ValueError("Unexpected image record fields")
        service = record["service"]
        if service not in SERVICES or service in images:
            raise ValueError("Unexpected or duplicate image service")
        if record["sha"] != sha or record["schema_sha256"] != schema:
            raise ValueError("Image record belongs to another source version")
        images[service] = require(record["digest"], DIGEST, "image digest")
    if set(images) != set(SERVICES):
        raise ValueError("All three image digests are required")
    return {"operation": "deploy", "trigger": trigger, "sha": sha,
            "schema_sha256": schema, "images": images}


def check_status(status, schema, trigger):
    require(schema, HASH, "schema fingerprint")
    if trigger not in TRIGGERS:
        raise ValueError("Unsupported release trigger")
    if status.get("recovery_required") is True:
        raise ValueError("Pending recovery requires operator rollback before a new deployment")
    if status.get("schema_sha256") != schema:
        raise ValueError("Schema differs from the last accepted database state; operator approval required")
    # An expired backup must reach the server's fixed refresh hook. The server
    # refreshes AND restore-verifies it before any container update; CI never
    # waives that gate or supplies an executable backup command.
    if status.get("rollback_verified") is not True:
        raise ValueError("Rollback baseline has not been verified")
    if status.get("paused") is not False:
        raise ValueError("Server deployment is paused or its state is unknown")
    if trigger == "push" and status.get("auto_deploy_enabled") is not True:
        raise ValueError("Server automatic deployment is disabled")


def verify_release(request, status):
    if status.get("sha") != request.get("sha") or status.get("schema_sha256") != request.get("schema_sha256"):
        raise ValueError("Server did not accept the requested source version")
    if status.get("images") != request.get("images"):
        raise ValueError("Server image digests differ from the requested release")


def validate_destination(host, user, port):
    # Ordinary IPv4/DNS is deliberate. IPv6 needs a separately reviewed known_hosts
    # and destination contract; untrusted strings never become SSH options.
    require(host, re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}\Z"), "VPS_HOST")
    require(user, re.compile(r"[a-z_][a-z0-9_-]{0,31}\Z"), "VPS_USER")
    if not str(port).isdigit() or not 1 <= int(port) <= 65535:
        raise ValueError("Invalid VPS_PORT")


def ssh_request(request, output):
    host, user = os.environ.get("VPS_HOST", ""), os.environ.get("VPS_USER", "")
    port = os.environ.get("VPS_PORT", "22") or "22"
    validate_destination(host, user, port)
    key = os.environ.get("VPS_SSH_KEY", "")
    known_hosts = os.environ.get("VPS_KNOWN_HOSTS", "")
    if not key or not known_hosts or len(key) > 32768 or len(known_hosts) > 32768:
        raise ValueError("Verified SSH key and known_hosts configuration are required")
    payload = Path(request).read_bytes()
    if len(payload) > 8192:
        raise ValueError("Request exceeds protocol size")
    json.loads(payload)
    # The runner is ephemeral; files are removed even on an SSH failure. No set -x,
    # command-line key material, agent forwarding, TOFU or host-key scan is used.
    with tempfile.TemporaryDirectory(prefix="crm-staging-ssh-") as tmp:
        os.chmod(tmp, 0o700)
        identity, hosts = Path(tmp) / "key", Path(tmp) / "known_hosts"
        for path, content in ((identity, key), (hosts, known_hosts)):
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(content.rstrip("\r\n") + "\n")
        completed = subprocess.run([
            "ssh", "-F", "/dev/null", "-T", "-p", str(port), "-i", str(identity),
            "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={hosts}",
            "-o", "GlobalKnownHostsFile=/dev/null", "-o", "UpdateHostKeys=no",
            "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
            "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=30",
            "-o", "ServerAliveCountMax=4", f"{user}@{host}", "ainativecrm-deploy"
        ], input=payload, capture_output=True, timeout=1800, check=False)
    # Do not relay SSH stderr or arbitrary server output into Actions logs/artifacts.
    # Full deployment logs remain in the protected server release directory.
    if completed.returncode:
        raise ValueError(f"Restricted SSH operation failed (exit {completed.returncode}); inspect protected VPS release logs")
    if len(completed.stdout) > 65536:
        raise ValueError("Server response exceeds protocol size")
    response = json.loads(completed.stdout)
    if not isinstance(response, dict):
        raise ValueError("Server returned an invalid release response")
    allowed = {"sha", "schema_sha256", "images", "backup_verified", "rollback_verified",
               "auto_deploy_enabled", "paused", "result", "health", "operation", "timestamp",
               "ok", "project", "recovery_required", "transaction"}
    write_json(output, {k: v for k, v in response.items() if k in allowed})


def write_json(path, value):
    Path(path).write_text(json.dumps(value, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    schema = commands.add_parser("schema-fingerprint")
    schema.add_argument("sha")
    record = commands.add_parser("image-record")
    record.add_argument("--sha", required=True)
    record.add_argument("--schema", required=True)
    record.add_argument("--service", required=True, choices=SERVICES)
    record.add_argument("--digest", required=True)
    record.add_argument("--output", required=True)
    manifest = commands.add_parser("manifest")
    manifest.add_argument("--directory", required=True)
    manifest.add_argument("--sha", required=True)
    manifest.add_argument("--schema", required=True)
    manifest.add_argument("--trigger", required=True, choices=TRIGGERS)
    manifest.add_argument("--output", required=True)
    status = commands.add_parser("check-status")
    status.add_argument("--status", required=True)
    status.add_argument("--schema", required=True)
    status.add_argument("--trigger", required=True, choices=TRIGGERS)
    request = commands.add_parser("request")
    request.add_argument("operation", choices=("status", "rollback"))
    request.add_argument("--output", required=True)
    ssh = commands.add_parser("ssh-request")
    ssh.add_argument("--request", required=True)
    ssh.add_argument("--output", required=True)
    verify = commands.add_parser("verify-release")
    verify.add_argument("--request", required=True)
    verify.add_argument("--status", required=True)
    args = parser.parse_args()
    if args.command == "schema-fingerprint":
        print(schema_fingerprint(args.sha))
    elif args.command == "image-record":
        write_json(args.output, {"service": args.service, "sha": require(args.sha, SHA, "SHA"),
            "schema_sha256": require(args.schema, HASH, "schema"), "digest": require(args.digest, DIGEST, "digest")})
    elif args.command == "manifest":
        write_json(args.output, make_manifest(args.directory, args.sha, args.schema, args.trigger))
    elif args.command == "check-status":
        check_status(json.loads(Path(args.status).read_text()), args.schema, args.trigger)
    elif args.command == "request":
        write_json(args.output, {"operation": args.operation})
    elif args.command == "ssh-request":
        ssh_request(args.request, args.output)
    elif args.command == "verify-release":
        verify_release(json.loads(Path(args.request).read_text()), json.loads(Path(args.status).read_text()))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        # Static validation messages contain field names and exit status, not values.
        print(f"staging release blocked: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
