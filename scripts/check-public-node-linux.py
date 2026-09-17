#!/usr/bin/env python3
"""Fail-closed health validation for a running Konofix public Node on Linux.

The checker intentionally has no third-party dependencies so it can ship inside the
Linux Node bundle and run on a minimal VPS with Python 3.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
import time
from pathlib import Path

MAX_HEALTH_BYTES = 64 * 1024
DEFAULT_MAX_AGE = 120
DEFAULT_FUTURE_TOLERANCE = 30
SOURCE_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")


class ValidationError(RuntimeError):
    pass


def _json_int(payload: dict[str, object], name: str) -> int:
    value = payload.get(name)
    if type(value) is not int:
        raise ValidationError(f"{name} must be a JSON integer")
    return value


def _json_text(payload: dict[str, object], name: str) -> str:
    value = payload.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{name} must be a non-empty JSON string")
    return value


def load_health(path: Path) -> dict[str, object]:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ValidationError(f"cannot stat health file {path}: {exc}") from exc
    if size <= 0:
        raise ValidationError("health file is empty")
    if size > MAX_HEALTH_BYTES:
        raise ValidationError(
            f"health file is too large ({size} bytes; maximum {MAX_HEALTH_BYTES})"
        )
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValidationError(f"cannot read health file {path}: {exc}") from exc
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValidationError(f"health file is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValidationError("health document root must be a JSON object")
    return payload


def validate_health(
    payload: dict[str, object],
    *,
    now: int,
    max_age: int = DEFAULT_MAX_AGE,
    future_tolerance: int = DEFAULT_FUTURE_TOLERANCE,
    min_uptime: int = 0,
    min_peers: int = 0,
    expected_version: str | None = None,
    expected_source_commit: str | None = None,
    expected_peer_id: str | None = None,
) -> dict[str, object]:
    schema = _json_int(payload, "schema")
    if schema != 2:
        raise ValidationError(f"unsupported health schema: {schema}")

    status = _json_text(payload, "status")
    if status != "running":
        raise ValidationError(f"Node status is not running: {status}")

    version = _json_text(payload, "version")
    source_commit = _json_text(payload, "source_commit")
    peer_id = _json_text(payload, "peer_id")
    uptime = _json_int(payload, "uptime_seconds")
    peers = _json_int(payload, "connected_peers")
    timestamp = _json_int(payload, "timestamp_unix")

    if uptime < 0:
        raise ValidationError("uptime_seconds must not be negative")
    if peers < 0:
        raise ValidationError("connected_peers must not be negative")
    if timestamp <= 0:
        raise ValidationError("timestamp_unix must be positive")
    if uptime > timestamp:
        raise ValidationError("uptime_seconds is impossible for timestamp_unix")
    if timestamp > now + future_tolerance:
        raise ValidationError(
            f"health snapshot is too far in the future ({timestamp - now}s)"
        )
    if now - timestamp > max_age:
        raise ValidationError(f"health snapshot is stale ({now - timestamp}s old)")
    if uptime < min_uptime:
        raise ValidationError(
            f"Node uptime {uptime}s is below required minimum {min_uptime}s"
        )
    if peers < min_peers:
        raise ValidationError(
            f"connected peer count {peers} is below required minimum {min_peers}"
        )
    if not SOURCE_COMMIT_RE.fullmatch(source_commit):
        raise ValidationError("source_commit must be a canonical 40-character lowercase hex SHA")

    if expected_version is not None:
        if not expected_version.strip():
            raise ValidationError("expected version pin must not be empty")
        if version != expected_version:
            raise ValidationError(
                f"version mismatch: health={version} expected={expected_version}"
            )
    if expected_source_commit is not None:
        if not SOURCE_COMMIT_RE.fullmatch(expected_source_commit):
            raise ValidationError(
                "expected source commit pin must be a canonical 40-character lowercase hex SHA"
            )
        if source_commit != expected_source_commit:
            raise ValidationError(
                "source commit mismatch: "
                f"health={source_commit} expected={expected_source_commit}"
            )
    if expected_peer_id is not None:
        if not expected_peer_id.strip():
            raise ValidationError("expected Peer ID pin must not be empty")
        if peer_id != expected_peer_id:
            raise ValidationError(
                f"Peer ID mismatch: health={peer_id} expected={expected_peer_id}"
            )

    return {
        "schema": schema,
        "status": status,
        "version": version,
        "source_commit": source_commit,
        "peer_id": peer_id,
        "uptime_seconds": uptime,
        "connected_peers": peers,
        "timestamp_unix": timestamp,
    }


def verify_file(args: argparse.Namespace) -> int:
    if args.max_age < 1 or args.max_age > 86400:
        raise ValidationError("--max-age must be between 1 and 86400 seconds")
    if args.future_tolerance < 0 or args.future_tolerance > 3600:
        raise ValidationError("--future-tolerance must be between 0 and 3600 seconds")
    if args.min_uptime < 0 or args.min_uptime > 365 * 24 * 3600:
        raise ValidationError("--min-uptime is outside the supported range")
    if args.min_peers < 0 or args.min_peers > 1_000_000:
        raise ValidationError("--min-peers is outside the supported range")

    checked = validate_health(
        load_health(Path(args.health)),
        now=int(time.time()),
        max_age=args.max_age,
        future_tolerance=args.future_tolerance,
        min_uptime=args.min_uptime,
        min_peers=args.min_peers,
        expected_version=args.expected_version,
        expected_source_commit=args.expected_source_commit,
        expected_peer_id=args.expected_peer_id,
    )
    print(
        "PASS "
        f"peer_id={checked['peer_id']} "
        f"version={checked['version']} "
        f"source_commit={checked['source_commit']} "
        f"uptime={checked['uptime_seconds']}s "
        f"connected_peers={checked['connected_peers']} "
        f"timestamp={checked['timestamp_unix']}"
    )
    return 0


def _expect_fail(payload: dict[str, object], **kwargs: object) -> None:
    try:
        validate_health(payload, **kwargs)
    except ValidationError:
        return
    raise AssertionError("fixture unexpectedly passed validation")


def self_test() -> int:
    now = 1_800_000_000
    commit = "a" * 40
    peer = "12D3KooWKonofixSelfTestPeer"
    valid: dict[str, object] = {
        "schema": 2,
        "status": "running",
        "version": "0.4.2",
        "source_commit": commit,
        "peer_id": peer,
        "uptime_seconds": 600,
        "connected_peers": 3,
        "timestamp_unix": now - 5,
    }
    common = {
        "now": now,
        "max_age": 120,
        "future_tolerance": 30,
        "min_uptime": 300,
        "min_peers": 2,
        "expected_version": "0.4.2",
        "expected_source_commit": commit,
        "expected_peer_id": peer,
    }
    checked = validate_health(dict(valid), **common)
    assert checked["peer_id"] == peer

    fixtures: list[dict[str, object]] = []
    for key, value in (
        ("status", "stopped"),
        ("schema", True),
        ("connected_peers", True),
        ("uptime_seconds", 299),
        ("connected_peers", 1),
        ("timestamp_unix", now - 121),
        ("timestamp_unix", now + 31),
        ("source_commit", "A" * 40),
    ):
        fixture = dict(valid)
        fixture[key] = value
        fixtures.append(fixture)
    for fixture in fixtures:
        _expect_fail(fixture, **common)

    wrong_pin = dict(common)
    wrong_pin["expected_peer_id"] = "12D3KooWWrongPeer"
    _expect_fail(dict(valid), **wrong_pin)

    with tempfile.TemporaryDirectory(prefix="konofix-linux-health-") as tmp:
        root = Path(tmp)
        good = root / "good.json"
        good.write_text(json.dumps(valid), encoding="utf-8")
        assert load_health(good)["status"] == "running"
        too_large = root / "too-large.json"
        too_large.write_bytes(b"{" + b" " * MAX_HEALTH_BYTES + b"}")
        try:
            load_health(too_large)
        except ValidationError:
            pass
        else:
            raise AssertionError("oversized health file unexpectedly passed")

    print("Linux public Node health validator self-tests passed.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Fail-closed Konofix public Node health validation for Linux VPS deployments."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    verify = sub.add_parser("verify", help="validate one Node health snapshot")
    verify.add_argument("--health", required=True, help="path to node-health.json")
    verify.add_argument("--max-age", type=int, default=DEFAULT_MAX_AGE)
    verify.add_argument(
        "--future-tolerance", type=int, default=DEFAULT_FUTURE_TOLERANCE
    )
    verify.add_argument("--min-uptime", type=int, default=0)
    verify.add_argument("--min-peers", type=int, default=0)
    verify.add_argument("--expected-version")
    verify.add_argument("--expected-source-commit")
    verify.add_argument("--expected-peer-id")
    verify.set_defaults(func=verify_file)

    selftest = sub.add_parser("self-test", help="run deterministic validator tests")
    selftest.set_defaults(func=lambda _args: self_test())
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return args.func(args)
    except ValidationError as exc:
        print(f"ERROR: {exc}", file=os.sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
