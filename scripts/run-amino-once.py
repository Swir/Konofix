#!/usr/bin/env python3
"""Manual, read-only Amino RPC probe. Never a physical WORLD/WAN acceptance test."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

TEST = "cold_start::runtime::tests::public_amino_read_only_once"
ACK = "read-only-no-wan-claim"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def guard(env):
    expected = {
        "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_REPOSITORY": "Swir/Konofix",
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_RUN_ATTEMPT": "1",
        "AMINO_AUTHORIZATION": ACK,
    }
    for key, value in expected.items():
        require(env.get(key) == value, f"Unauthorized probe context: {key}")
    sha = env.get("GITHUB_SHA", "")
    require(re.fullmatch(r"[0-9a-f]{40}", sha), "Invalid source SHA")
    require(env.get("AMINO_EXPECTED_SHA") == sha, "Expected SHA differs from workflow source")
    require(re.fullmatch(r"[1-9][0-9]*", env.get("GITHUB_RUN_ID", "")), "Invalid run ID")
    return sha


def executable(messages, root):
    found = []
    for line in messages.splitlines():
        entry = json.loads(line)
        if (entry.get("reason") == "compiler-artifact"
                and entry.get("target", {}).get("name") == "konofix-node"
                and entry.get("profile", {}).get("test") is True
                and entry.get("executable")):
            found.append(Path(entry["executable"]).resolve())
    require(len(found) == 1, "Expected exactly one compiled Node test executable")
    require(found[0].is_relative_to(root.resolve()) and found[0].is_file(),
            "Test executable must belong to this checkout")
    return found[0]


def validate_report(report, sha):
    for key, value in {
        "schema": 2, "kind": "konofix-amino-read-only-interop", "source_commit": sha,
        "provider_writes": 0, "value_writes": 0, "chat_messages": 0,
        "physical_wan_acceptance": "NOT_EVALUATED",
        "remote_ttl": "none requested: read-only",
        "limits": {"seconds": 30, "dials_per_300_seconds": 64,
                   "connections": 16, "pending_dials": 4, "queries": 1},
    }.items():
        require(report.get(key) == value, f"Evidence mismatch: {key}")
    prefix = "konofix/experimental/interop-read-only/"
    namespace = report.get("namespace", "")
    require(isinstance(namespace, str) and namespace.startswith(prefix), "Wrong probe namespace")
    suffix = namespace[len(prefix):]
    parsed = uuid.UUID(suffix)
    require(parsed.version == 4 and str(parsed) == suffix, "Namespace must use a fresh-format UUIDv4")
    for field in ["schema", "provider_writes", "value_writes", "chat_messages",
                  "authenticated_connections", "outgoing_errors", "query_requests",
                  "query_successes", "elapsed_ms", "started_unix", "unexpected_queries"]:
        require(type(report.get(field)) is int and report[field] >= 0, f"Invalid counter: {field}")
    for field in ["query_completed", "deadline_exceeded"]:
        require(type(report.get(field)) is bool, f"Invalid flag: {field}")
    stages = report.get("transport_stages", {})
    require(set(stages) == {"dns_candidates", "resolved_transport_candidates",
                            "policy_or_budget_rejections", "accepted_transport_dials"},
            "Missing transport-stage counters")
    require(all(type(value) is int and value >= 0 for value in stages.values()), "Invalid transport-stage counter")
    require(stages["accepted_transport_dials"] <= 64, "Dial budget exceeded")
    require(report.get("outcome") in ["RPC_INTEROPERABILITY_PASS", "NO_COMPLETED_INTEROPERABILITY_PROOF"],
            "Unknown RPC outcome")
    passed = (report["authenticated_connections"] > 0 and report["query_successes"] > 0
              and report["query_completed"] and not report["deadline_exceeded"]
              and report["unexpected_queries"] == 0)
    require((report["outcome"] == "RPC_INTEROPERABILITY_PASS") == passed, "Contradictory RPC outcome")
    return passed


def write_new(path, value):
    with path.open("x", encoding="utf-8") as output:
        json.dump(value, output, indent=2)
        output.write("\n")


def run(root, messages, directory, env):
    sha = guard(env)
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    require(actual == sha, "Checkout does not match authorized SHA")
    binary = executable(messages.read_text(), root)
    # Listing an ignored test never executes it. A stale/wrong binary selecting
    # zero tests must fail before any external request, even if libtest exits 0.
    listing = subprocess.run([str(binary), "--list", "--ignored", "--exact", TEST],
                             capture_output=True, text=True, timeout=10, check=True)
    require(listing.stdout.splitlines().count(f"{TEST}: test") == 1,
            "Exactly one named ignored public probe must exist")
    directory.mkdir(parents=False, exist_ok=False)
    write_new(directory / "intent.json", {
        "schema": 1, "source_commit": sha, "run_id": env["GITHUB_RUN_ID"],
        "run_attempt": 1, "test": TEST,
        "executable_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "maximum_process_seconds": 45, "physical_wan_acceptance": "NOT_EVALUATED",
        "scope": "one read-only RPC query; no retry, announce, value PUT, chat or relay",
    })
    probe_env = dict(env, KONOFIX_ALLOW_PUBLIC_AMINO_ONCE=ACK,
                     KONOFIX_AMINO_PROBE_OUTPUT=str(directory / "probe.json"))
    exit_code, error = None, None
    try:
        with (directory / "process.log").open("x", encoding="utf-8") as log:
            result = subprocess.run([str(binary), "--ignored", "--exact", TEST],
                                    stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                    cwd=root, env=probe_env, timeout=45, check=False)
            exit_code = result.returncode
    except subprocess.TimeoutExpired:
        error = "OS process deadline exceeded; no retry"
    except OSError as failure:
        error = f"Process launch failed: {type(failure).__name__}"
    passed = False
    try:
        evidence = directory / "probe.json"
        require(evidence.stat().st_size <= 65536, "Unexpected evidence size")
        passed = validate_report(json.loads(evidence.read_text()), sha)
    except (OSError, ValueError, TypeError, KeyError) as failure:
        error = "; ".join(filter(None, [error, f"Invalid or incomplete evidence: {failure}"]))
    success = passed and exit_code == 0 and error is None
    write_new(directory / "result.json", {
        "schema": 1, "source_commit": sha, "exit_code": exit_code, "error": error,
        "outcome": "RPC_INTEROPERABILITY_PASS" if success else "NO_COMPLETED_INTEROPERABILITY_PROOF",
        "physical_wan_acceptance": "NOT_EVALUATED",
    })
    write_new(directory / "sha256.json", {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.iterdir()) if path.is_file()
    })
    print(f"Evidence: {directory}; RPC proof={success}; physical WAN NOT_EVALUATED")
    return 0 if success else 1


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["preflight"]:
            print(f"Authorized one-shot read-only source: {guard(os.environ)}")
        else:
            require(len(sys.argv) == 4 and sys.argv[1] == "run", "Usage: preflight | run CARGO_JSON NEW_DIRECTORY")
            sys.exit(run(Path.cwd(), Path(sys.argv[2]), Path(sys.argv[3]), os.environ))
    except (ValueError, OSError, subprocess.SubprocessError) as failure:
        print(f"Probe refused/failed: {failure}", file=sys.stderr)
        sys.exit(1)
