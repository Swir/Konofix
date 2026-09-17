#!/usr/bin/env python3
"""Fail-closed parity checks for the isolated Linux Node/Netprobe Cargo target."""

from __future__ import annotations

import argparse
import copy
import pathlib
import tempfile
import tomllib
from dataclasses import dataclass


class ParityError(RuntimeError):
    pass


SHARED_PACKAGE_FIELDS = (
    "name",
    "version",
    "description",
    "authors",
    "edition",
    "rust-version",
)
EXPECTED_BINS = {
    "konofix-node": "src/main.rs",
    "konofix-netprobe": "src/netprobe.rs",
}
EXPECTED_WRAPPERS = {
    "src/main.rs": "../../src-tauri/src/bin/konofix-node.rs",
    "src/netprobe.rs": "../../src-tauri/src/bin/konofix-netprobe.rs",
}


@dataclass(frozen=True)
class Inputs:
    desktop_manifest: pathlib.Path
    linux_manifest: pathlib.Path
    linux_root: pathlib.Path


def load_toml(path: pathlib.Path) -> dict:
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise ParityError(f"Could not read valid TOML from {path}: {exc}") from exc


def nested(mapping: dict, *keys: str):
    current = mapping
    for key in keys:
        try:
            current = current[key]
        except (KeyError, TypeError) as exc:
            joined = ".".join(keys)
            raise ParityError(f"Manifest is missing required field/table: {joined}") from exc
    return current


def assert_equal(label: str, expected, actual) -> None:
    if expected != actual:
        raise ParityError(f"Isolated Linux Node manifest drift: {label}")


def normalize_relative(path_value: str) -> str:
    return pathlib.PurePosixPath(path_value.replace("\\", "/")).as_posix()


def validate_manifests(desktop: dict, linux: dict) -> None:
    desktop_package = nested(desktop, "package")
    linux_package = nested(linux, "package")
    for field in SHARED_PACKAGE_FIELDS:
        assert_equal(
            f"package.{field}",
            nested(desktop_package, field),
            nested(linux_package, field),
        )

    assert_equal("dependencies", nested(desktop, "dependencies"), nested(linux, "dependencies"))
    assert_equal(
        "windows dependencies",
        nested(desktop, "target", "cfg(windows)", "dependencies"),
        nested(linux, "target", "cfg(windows)", "dependencies"),
    )
    assert_equal(
        "windows build-dependencies",
        nested(desktop, "target", "cfg(windows)", "build-dependencies"),
        nested(linux, "target", "cfg(windows)", "build-dependencies"),
    )

    bins = linux.get("bin")
    if not isinstance(bins, list):
        raise ParityError("node-linux/Cargo.toml must declare the isolated Node and Netprobe bins explicitly.")

    actual_bins: dict[str, str] = {}
    for entry in bins:
        if not isinstance(entry, dict):
            raise ParityError("node-linux/Cargo.toml contains a malformed [[bin]] entry.")
        name = entry.get("name")
        path = entry.get("path")
        if not isinstance(name, str) or not isinstance(path, str):
            raise ParityError("Each isolated [[bin]] entry must have string name/path values.")
        if name in actual_bins:
            raise ParityError(f"Duplicate isolated [[bin]] name: {name}")
        actual_bins[name] = normalize_relative(path)
    assert_equal("isolated binary targets", EXPECTED_BINS, actual_bins)


def validate_wrapper(linux_root: pathlib.Path, relative: str, expected_include: str) -> None:
    wrapper = linux_root / relative
    try:
        text = wrapper.read_text(encoding="utf-8")
    except OSError as exc:
        raise ParityError(f"Could not read isolated source wrapper {wrapper}: {exc}") from exc

    expected_statement = f'include!("{expected_include}");'
    active_lines = [
        raw.strip()
        for raw in text.splitlines()
        if raw.strip() and not raw.strip().startswith("//")
    ]
    if active_lines != [expected_statement]:
        raise ParityError(
            f"Wrapper {relative} must contain only comments plus exactly {expected_statement}; "
            f"active lines were {active_lines or 'none'}."
        )

    resolved = (wrapper.parent / expected_include).resolve()
    # The include literal is pinned above. Also require it to resolve to a real
    # production source file so a rename/removal cannot leave Linux CI testing a
    # stale or broken bridge.
    if not resolved.is_file():
        raise ParityError(f"Wrapper {relative} include target does not exist: {resolved}")


def check(inputs: Inputs) -> None:
    desktop = load_toml(inputs.desktop_manifest)
    linux = load_toml(inputs.linux_manifest)
    validate_manifests(desktop, linux)
    for relative, expected in EXPECTED_WRAPPERS.items():
        validate_wrapper(inputs.linux_root, relative, expected)


def expect_failure(label: str, fn) -> None:
    try:
        fn()
    except ParityError:
        return
    raise AssertionError(f"Adversarial self-test unexpectedly passed: {label}")


def self_test(repo_root: pathlib.Path) -> None:
    desktop = load_toml(repo_root / "src-tauri" / "Cargo.toml")
    linux = load_toml(repo_root / "node-linux" / "Cargo.toml")

    validate_manifests(desktop, linux)

    changed_edition = copy.deepcopy(linux)
    changed_edition["package"]["edition"] = "2024"
    expect_failure("package edition drift", lambda: validate_manifests(desktop, changed_edition))

    changed_dependency = copy.deepcopy(linux)
    changed_dependency["dependencies"]["hex"] = "0.3"
    expect_failure("shared dependency drift", lambda: validate_manifests(desktop, changed_dependency))

    changed_bin = copy.deepcopy(linux)
    changed_bin["bin"][0]["path"] = "src/other.rs"
    expect_failure("isolated binary path drift", lambda: validate_manifests(desktop, changed_bin))

    with tempfile.TemporaryDirectory(prefix="konofix-linux-parity-") as temp:
        root = pathlib.Path(temp)
        linux_root = root / "node-linux"
        wrapper_dir = linux_root / "src"
        wrapper_dir.mkdir(parents=True)
        production_dir = root / "src-tauri" / "src" / "bin"
        production_dir.mkdir(parents=True)
        (production_dir / "konofix-node.rs").write_text("fn main() {}\n", encoding="utf-8")
        (production_dir / "konofix-netprobe.rs").write_text("fn main() {}\n", encoding="utf-8")
        (wrapper_dir / "main.rs").write_text(
            '// canonical bridge\ninclude!("../../src-tauri/src/bin/konofix-node.rs");\n', encoding="utf-8"
        )
        (wrapper_dir / "netprobe.rs").write_text(
            'include!("../../src-tauri/src/bin/konofix-netprobe.rs");\n', encoding="utf-8"
        )
        validate_wrapper(linux_root, "src/main.rs", EXPECTED_WRAPPERS["src/main.rs"])
        validate_wrapper(linux_root, "src/netprobe.rs", EXPECTED_WRAPPERS["src/netprobe.rs"])

        (wrapper_dir / "main.rs").write_text(
            'include!("../../src-tauri/src/bin/konofix-netprobe.rs");\n', encoding="utf-8"
        )
        expect_failure(
            "production source bridge drift",
            lambda: validate_wrapper(linux_root, "src/main.rs", EXPECTED_WRAPPERS["src/main.rs"]),
        )

        (wrapper_dir / "main.rs").write_text(
            '// include!("../../src-tauri/src/bin/konofix-node.rs");\n', encoding="utf-8"
        )
        expect_failure(
            "commented include decoy",
            lambda: validate_wrapper(linux_root, "src/main.rs", EXPECTED_WRAPPERS["src/main.rs"]),
        )

        (wrapper_dir / "main.rs").write_text(
            'fn shadow_linux_only() {}\ninclude!("../../src-tauri/src/bin/konofix-node.rs");\n', encoding="utf-8"
        )
        expect_failure(
            "extra Linux-only executable source",
            lambda: validate_wrapper(linux_root, "src/main.rs", EXPECTED_WRAPPERS["src/main.rs"]),
        )

    print("Isolated Linux Node parity adversarial self-tests: PASS")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("check", "self-test"))
    args = parser.parse_args()

    repo_root = pathlib.Path(__file__).resolve().parent.parent
    if args.mode == "self-test":
        self_test(repo_root)
        return 0

    inputs = Inputs(
        desktop_manifest=repo_root / "src-tauri" / "Cargo.toml",
        linux_manifest=repo_root / "node-linux" / "Cargo.toml",
        linux_root=repo_root / "node-linux",
    )
    try:
        check(inputs)
    except ParityError as exc:
        raise SystemExit(str(exc)) from exc
    print("Isolated Linux Node manifest and source bridges match the shared production build inputs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
