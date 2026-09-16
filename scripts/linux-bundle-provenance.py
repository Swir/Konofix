#!/usr/bin/env python3
"""Create and verify Konofix Linux Node bundle provenance without trusting extraction."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
import tempfile

EXPECTED_FILES = (
    "konofix-node",
    "scripts/install-public-node-linux.sh",
    "docs/NODE.md",
    "docs/NODE_SOAK.md",
    "docs/NODE_LINUX.md",
)
EXPECTED_DIRS = {"scripts", "docs"}
METADATA_NAME = "NODE_BUILD_INFO.json"
SHA256_RE = re.compile(r"[0-9a-f]{64}")
COMMIT_RE = re.compile(r"[0-9a-f]{40}")
MAX_METADATA_BYTES = 64 * 1024


class VerificationError(RuntimeError):
    """Raised when bundle provenance fails closed."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def describe_file(root: Path, relative: str) -> dict[str, object]:
    path = root / relative
    if not path.is_file():
        raise VerificationError(f"Required Linux bundle file is missing: {relative}")
    data = path.read_bytes()
    if not data:
        raise VerificationError(f"Required Linux bundle file is empty: {relative}")
    return {
        "path": relative,
        "bytes": len(data),
        "sha256": sha256_bytes(data),
    }


def validate_commit(value: object, label: str) -> str:
    if not isinstance(value, str) or not COMMIT_RE.fullmatch(value):
        raise VerificationError(f"{label} must be an exact lowercase 40-character Git commit.")
    return value


def validate_version(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 64:
        raise VerificationError(f"{label} must be a non-empty version string up to 64 characters.")
    return value


def build_metadata(root: Path, commit: str, version: str) -> dict[str, object]:
    validate_commit(commit, "Source commit")
    validate_version(version, "Version")
    files = [describe_file(root, relative) for relative in EXPECTED_FILES]
    return {
        "schema": 1,
        "product": "Konofix Node",
        "platform": "linux-x86_64",
        "version": version,
        "commit": commit,
        "node": files[0],
        "files": files,
    }


def write_metadata(root: Path, commit: str, version: str) -> None:
    metadata = build_metadata(root, commit, version)
    (root / METADATA_NAME).write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def normalize_member_name(raw_name: str) -> str:
    name = raw_name
    while name.startswith("./"):
        name = name[2:]
    if name in {"", "."}:
        return ""
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise VerificationError(f"Unsafe archive member path: {raw_name}")
    normalized = path.as_posix()
    if normalized.startswith("/"):
        raise VerificationError(f"Unsafe archive member path: {raw_name}")
    return normalized


def parse_checksum(checksum_path: Path, archive_path: Path) -> str:
    raw = checksum_path.read_bytes()
    if len(raw) > 1024:
        raise VerificationError("Linux archive checksum file is unexpectedly large.")
    try:
        text = raw.decode("ascii").strip()
    except UnicodeDecodeError as exc:
        raise VerificationError("Linux archive checksum file must be ASCII.") from exc
    match = re.fullmatch(r"([0-9a-f]{64}) [ *](.+)", text)
    if not match:
        raise VerificationError("Linux archive checksum file has an invalid format.")
    digest, recorded_name = match.groups()
    if Path(recorded_name).name != archive_path.name or recorded_name != archive_path.name:
        raise VerificationError("Linux archive checksum names a different file.")
    return digest


def read_member_bytes(archive: tarfile.TarFile, member: tarfile.TarInfo, limit: int | None = None) -> bytes:
    if limit is not None and member.size > limit:
        raise VerificationError(f"Archive member is too large: {member.name}")
    extracted = archive.extractfile(member)
    if extracted is None:
        raise VerificationError(f"Unable to read archive member: {member.name}")
    data = extracted.read((limit + 1) if limit is not None else -1)
    if limit is not None and len(data) > limit:
        raise VerificationError(f"Archive member is too large: {member.name}")
    if len(data) != member.size:
        raise VerificationError(f"Archive member size changed while reading: {member.name}")
    return data


def validate_metadata(metadata: object, expected_commit: str, expected_version: str) -> dict[str, dict[str, object]]:
    if not isinstance(metadata, dict):
        raise VerificationError("Linux bundle metadata root must be a JSON object.")
    if type(metadata.get("schema")) is not int or metadata.get("schema") != 1:
        raise VerificationError("Unexpected Linux bundle metadata schema.")
    if metadata.get("product") != "Konofix Node" or metadata.get("platform") != "linux-x86_64":
        raise VerificationError("Linux bundle product/platform metadata mismatch.")
    version = validate_version(metadata.get("version"), "Bundle version")
    commit = validate_commit(metadata.get("commit"), "Bundle source commit")
    if version != expected_version:
        raise VerificationError("Linux bundle version metadata mismatch.")
    if commit != expected_commit:
        raise VerificationError("Linux bundle source commit metadata mismatch.")

    entries = metadata.get("files")
    if not isinstance(entries, list) or len(entries) != len(EXPECTED_FILES):
        raise VerificationError("Linux bundle file provenance list is incomplete.")

    by_path: dict[str, dict[str, object]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise VerificationError("Linux bundle file provenance entry must be an object.")
        relative = entry.get("path")
        if not isinstance(relative, str) or relative not in EXPECTED_FILES:
            raise VerificationError(f"Unexpected Linux bundle provenance path: {relative!r}")
        if relative in by_path:
            raise VerificationError(f"Duplicate Linux bundle provenance path: {relative}")
        size = entry.get("bytes")
        digest = entry.get("sha256")
        if type(size) is not int or size <= 0:
            raise VerificationError(f"Invalid byte size for {relative}.")
        if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
            raise VerificationError(f"Invalid SHA-256 for {relative}.")
        by_path[relative] = entry

    if set(by_path) != set(EXPECTED_FILES):
        raise VerificationError("Linux bundle provenance does not cover the exact expected file set.")
    if metadata.get("node") != by_path["konofix-node"]:
        raise VerificationError("Legacy Node provenance block disagrees with the complete file manifest.")
    return by_path


def verify_bundle(archive_path: Path, checksum_path: Path, expected_commit: str, expected_version: str) -> None:
    expected_commit = validate_commit(expected_commit, "Expected source commit")
    expected_version = validate_version(expected_version, "Expected version")
    if not archive_path.is_file() or not checksum_path.is_file():
        raise VerificationError("Linux archive or checksum file is missing.")

    expected_archive_digest = parse_checksum(checksum_path, archive_path)
    actual_archive_digest = sha256_file(archive_path)
    if actual_archive_digest != expected_archive_digest:
        raise VerificationError("Linux archive SHA-256 does not match its checksum file.")

    files: dict[str, tarfile.TarInfo] = {}
    seen_dirs: set[str] = set()
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive.getmembers():
            normalized = normalize_member_name(member.name)
            if not normalized:
                if not member.isdir():
                    raise VerificationError("Archive root entry must be a directory.")
                continue
            if member.isdir():
                if normalized not in EXPECTED_DIRS:
                    raise VerificationError(f"Unexpected directory in Linux bundle: {normalized}")
                seen_dirs.add(normalized)
                continue
            if not member.isfile():
                raise VerificationError(f"Linux bundle contains a non-regular member: {normalized}")
            if normalized in files:
                raise VerificationError(f"Linux bundle contains a duplicate file: {normalized}")
            files[normalized] = member

        expected_inventory = set(EXPECTED_FILES) | {METADATA_NAME}
        if set(files) != expected_inventory:
            missing = sorted(expected_inventory - set(files))
            extra = sorted(set(files) - expected_inventory)
            raise VerificationError(f"Linux bundle inventory mismatch; missing={missing}, extra={extra}")
        if not EXPECTED_DIRS.issubset(seen_dirs):
            raise VerificationError("Linux bundle is missing expected directory entries.")

        metadata_bytes = read_member_bytes(archive, files[METADATA_NAME], MAX_METADATA_BYTES)
        try:
            metadata = json.loads(metadata_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise VerificationError("Linux bundle metadata is not valid UTF-8 JSON.") from exc
        by_path = validate_metadata(metadata, expected_commit, expected_version)

        for relative, entry in by_path.items():
            member = files[relative]
            if member.size != entry["bytes"]:
                raise VerificationError(f"Byte-size mismatch for {relative}.")
            data = read_member_bytes(archive, member)
            if sha256_bytes(data) != entry["sha256"]:
                raise VerificationError(f"SHA-256 mismatch for {relative}.")

        for executable in ("konofix-node", "scripts/install-public-node-linux.sh"):
            if files[executable].mode & 0o111 == 0:
                raise VerificationError(f"Expected executable mode is missing for {executable}.")


def write_checksum(archive_path: Path, checksum_path: Path) -> None:
    checksum_path.write_text(f"{sha256_file(archive_path)}  {archive_path.name}\n", encoding="ascii")


def make_fixture(root: Path, commit: str, version: str) -> tuple[Path, Path, Path]:
    stage = root / "artifact-linux"
    (stage / "scripts").mkdir(parents=True)
    (stage / "docs").mkdir(parents=True)
    payloads = {
        "konofix-node": b"fake-node-binary\n",
        "scripts/install-public-node-linux.sh": b"#!/usr/bin/env bash\necho fake\n",
        "docs/NODE.md": b"node docs\n",
        "docs/NODE_SOAK.md": b"soak docs\n",
        "docs/NODE_LINUX.md": b"linux docs\n",
    }
    for relative, data in payloads.items():
        path = stage / relative
        path.write_bytes(data)
    os.chmod(stage / "konofix-node", 0o755)
    os.chmod(stage / "scripts/install-public-node-linux.sh", 0o755)
    write_metadata(stage, commit, version)
    archive = root / "Konofix-Node-0.4.2-Linux-x86_64.tar.gz"
    with tarfile.open(archive, "w:gz") as handle:
        handle.add(stage, arcname=".")
    checksum = root / (archive.name + ".sha256")
    write_checksum(archive, checksum)
    return stage, archive, checksum


def expect_failure(label: str, callback) -> None:
    try:
        callback()
    except VerificationError:
        print(f"Expected rejection passed: {label}")
        return
    raise AssertionError(f"Expected verification failure was accepted: {label}")


def run_self_test() -> None:
    commit = "a" * 40
    version = "0.4.2"
    with tempfile.TemporaryDirectory(prefix="konofix-linux-provenance-") as tmp:
        root = Path(tmp)
        stage, archive, checksum = make_fixture(root, commit, version)
        verify_bundle(archive, checksum, commit, version)

        (stage / "docs/NODE.md").write_text("tampered docs\n", encoding="utf-8")
        tampered = root / "tampered.tar.gz"
        with tarfile.open(tampered, "w:gz") as handle:
            handle.add(stage, arcname=".")
        tampered_sum = root / "tampered.tar.gz.sha256"
        write_checksum(tampered, tampered_sum)
        expect_failure("tampered documented file", lambda: verify_bundle(tampered, tampered_sum, commit, version))

        stage, _, _ = make_fixture(root / "extra-case", commit, version)
        (stage / "extra.txt").write_text("unexpected\n", encoding="utf-8")
        extra = root / "extra.tar.gz"
        with tarfile.open(extra, "w:gz") as handle:
            handle.add(stage, arcname=".")
        extra_sum = root / "extra.tar.gz.sha256"
        write_checksum(extra, extra_sum)
        expect_failure("unexpected archive inventory", lambda: verify_bundle(extra, extra_sum, commit, version))

        stage, _, _ = make_fixture(root / "unsafe-case", commit, version)
        unsafe = root / "unsafe.tar.gz"
        with tarfile.open(unsafe, "w:gz") as handle:
            handle.add(stage, arcname=".")
            info = tarfile.TarInfo("../escape.txt")
            payload = b"escape\n"
            info.size = len(payload)
            handle.addfile(info, io.BytesIO(payload))
        unsafe_sum = root / "unsafe.tar.gz.sha256"
        write_checksum(unsafe, unsafe_sum)
        expect_failure("archive path traversal", lambda: verify_bundle(unsafe, unsafe_sum, commit, version))

        expect_failure("wrong source commit", lambda: verify_bundle(archive, checksum, "b" * 40, version))
        expect_failure("wrong version", lambda: verify_bundle(archive, checksum, commit, "9.9.9"))

    print("Linux bundle provenance self-tests passed.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build-info", help="write NODE_BUILD_INFO.json for a staged Linux bundle")
    build.add_argument("--root", required=True, type=Path)
    build.add_argument("--commit", required=True)
    build.add_argument("--version", required=True)

    verify = sub.add_parser("verify", help="verify a Linux Node tarball without extracting it")
    verify.add_argument("--archive", required=True, type=Path)
    verify.add_argument("--checksum", required=True, type=Path)
    verify.add_argument("--expected-commit", required=True)
    verify.add_argument("--expected-version", required=True)

    sub.add_parser("self-test", help="run positive and adversarial provenance tests")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.command == "build-info":
            write_metadata(args.root, args.commit, args.version)
            print(f"Wrote verified Linux bundle provenance metadata: {args.root / METADATA_NAME}")
        elif args.command == "verify":
            verify_bundle(args.archive, args.checksum, args.expected_commit, args.expected_version)
            print("Linux bundle provenance PASS: exact inventory, source commit, sizes and SHA-256 hashes verified.")
        elif args.command == "self-test":
            run_self_test()
        return 0
    except (OSError, tarfile.TarError, VerificationError, AssertionError) as exc:
        print(f"ERROR: {exc}", file=os.sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
