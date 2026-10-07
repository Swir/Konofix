#!/usr/bin/env python3
"""Offline fail-closed tests. Only generated fixture executables, no public sockets."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("probe", Path(__file__).with_name("run-amino-once.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
SHA = "a" * 40


def context(sha=SHA):
    return dict(os.environ, GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_REPOSITORY="Swir/Konofix",
                GITHUB_REF="refs/heads/main", GITHUB_RUN_ATTEMPT="1", GITHUB_RUN_ID="123",
                GITHUB_SHA=sha, AMINO_EXPECTED_SHA=sha, AMINO_AUTHORIZATION=probe.ACK)


def report(sha=SHA):
    return dict(schema=1, kind="konofix-amino-read-only-interop", source_commit=sha,
                namespace="konofix/experimental/interop-read-only/65795ef4-bfb0-4f69-8803-4f1809f40ef3",
                provider_writes=0, value_writes=0, chat_messages=0,
                physical_wan_acceptance="NOT_EVALUATED", remote_ttl="none requested: read-only",
                limits=dict(seconds=30, dials_per_300_seconds=64, connections=16, pending_dials=4, queries=1),
                authenticated_connections=0, outgoing_errors=0, query_requests=2, query_successes=0,
                query_completed=False, deadline_exceeded=False, elapsed_ms=15000, started_unix=1791391323,
                transport_stages=dict(dns_candidates=2, resolved_transport_candidates=0,
                                      policy_or_budget_rejections=0, accepted_transport_dials=0),
                outcome="NO_COMPLETED_INTEROPERABILITY_PROOF")


class Guards(unittest.TestCase):
    def test_authorization_is_bound_to_manual_first_attempt_and_exact_main(self):
        self.assertEqual(probe.guard(context()), SHA)
        for key, bad in {"GITHUB_EVENT_NAME": "push", "GITHUB_REPOSITORY": "another/repo",
                         "GITHUB_REF": "refs/heads/experiment", "GITHUB_RUN_ATTEMPT": "2",
                         "GITHUB_RUN_ID": "0", "AMINO_AUTHORIZATION": "yes",
                         "AMINO_EXPECTED_SHA": "b" * 40, "GITHUB_SHA": "not-a-commit"}.items():
            with self.subTest(key=key), self.assertRaises(ValueError):
                probe.guard(dict(context(), **{key: bad}))

    def test_rpc_and_physical_wan_outcomes_cannot_be_conflated(self):
        self.assertFalse(probe.validate_report(report(), SHA))
        for field, bad in {"outcome": "RPC_INTEROPERABILITY_PASS", "physical_wan_acceptance": "PASS",
                           "source_commit": "b" * 40, "namespace": "konofix/experimental/world/v2",
                           "provider_writes": 1, "chat_messages": False, "query_requests": -1,
                           "query_completed": 1, "limits": {"queries": 2},
                           "transport_stages": {}}.items():
            with self.subTest(field=field), self.assertRaises(ValueError):
                probe.validate_report(dict(report(), **{field: bad}), SHA)
        passed = dict(report(), authenticated_connections=1, query_successes=1, query_completed=True,
                      outcome="RPC_INTEROPERABILITY_PASS")
        self.assertTrue(probe.validate_report(passed, SHA))
        with self.assertRaises(ValueError):
            probe.validate_report(dict(passed, deadline_exceeded=True), SHA)

    def test_runner_rejects_zero_tests_and_preserves_failure_without_second_execution(self):
        with tempfile.TemporaryDirectory(prefix="konofix-amino-offline-") as temporary:
            root = Path(temporary)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                            "commit", "--allow-empty", "-qm", "offline fixture"], cwd=root, check=True)
            sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
            binary = root / "fixture.py"
            messages = root / "build.json"
            messages.write_text(json.dumps(dict(reason="compiler-artifact", target=dict(name="konofix-node"),
                                                 profile=dict(test=True), executable=str(binary))) + "\n")
            def fixture(listing, body):
                binary.write_text(f"#!{sys.executable}\nimport sys,os,json,pathlib\n"
                                  f"if '--list' in sys.argv:\n print({listing!r});sys.exit(0)\n" + body)
                binary.chmod(0o700)
            fixture("0 tests, 0 benchmarks", "raise RuntimeError('must not execute')\n")
            target = root / "attempt"
            with self.assertRaises(ValueError):
                probe.run(root, messages, target, context(sha))
            self.assertFalse(target.exists())
            fixture(probe.TEST + ": test\n\n1 test, 0 benchmarks",
                    "pathlib.Path('execution').open('x').write('once')\n"
                    f"pathlib.Path(os.environ['KONOFIX_AMINO_PROBE_OUTPUT']).open('x').write({json.dumps(report(sha))!r})\n"
                    "sys.exit(101)\n")
            self.assertEqual(probe.run(root, messages, target, context(sha)), 1)
            result = json.loads((target / "result.json").read_text())
            self.assertEqual(result["exit_code"], 101)
            self.assertEqual(result["outcome"], "NO_COMPLETED_INTEROPERABILITY_PROOF")
            original = {p.name: p.read_bytes() for p in target.iterdir()}
            with self.assertRaises(FileExistsError):
                probe.run(root, messages, target, context(sha))
            self.assertEqual(original, {p.name: p.read_bytes() for p in target.iterdir()})
            self.assertEqual((root / "execution").read_text(), "once")


if __name__ == "__main__":
    unittest.main()
