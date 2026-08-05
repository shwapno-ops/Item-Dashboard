#!/usr/bin/env python3
"""Validate required source files before downloading or processing dashboard data."""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MASTER_DIR = ROOT / "data" / "master"
DRIVE_CONFIG = ROOT / "data" / "drive_source.json"
SUPPORTED_MASTER_SUFFIXES = {".xlsx", ".xlsm"}
REQUIRED_PROJECT_FILES = (
    "index.html",
    "assets/css/styles.css",
    "assets/js/app.js",
    "scripts/download_drive_data.py",
    "scripts/build_data.py",
    "scripts/validate_build.py",
    "data/config.json",
    "data/drive_source.json",
)


def github_error(message: str, file: str | None = None) -> None:
    location = f" file={file}" if file else ""
    print(f"::error{location}::{message}")


def fail(message: str, file: str | None = None) -> None:
    github_error(message, file)
    raise SystemExit(message)


def master_candidates() -> list[Path]:
    if not MASTER_DIR.exists():
        return []
    return sorted(
        p
        for p in MASTER_DIR.iterdir()
        if p.is_file()
        and p.suffix.lower() in SUPPORTED_MASTER_SUFFIXES
        and not p.name.startswith("~$")
    )


def validate_master(path: Path) -> None:
    if path.stat().st_size < 1_000:
        fail(
            f"The master workbook is only {path.stat().st_size} bytes and is not a valid Excel workbook. "
            "Upload the real Zone Distribution workbook, not a shortcut or placeholder.",
            str(path.relative_to(ROOT)),
        )
    beginning = path.read_bytes()[:200]
    if beginning.startswith(b"version https://git-lfs.github.com/spec"):
        fail(
            "The master file is a Git LFS pointer. Store the actual workbook in the repository or download it during the workflow.",
            str(path.relative_to(ROOT)),
        )
    if not zipfile.is_zipfile(path):
        fail(
            "The master file is not a valid .xlsx/.xlsm Open XML workbook.",
            str(path.relative_to(ROOT)),
        )


def validate_drive_config() -> None:
    if not DRIVE_CONFIG.exists():
        fail("Missing data/drive_source.json", "data/drive_source.json")
    try:
        config = json.loads(DRIVE_CONFIG.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        fail(f"Invalid data/drive_source.json: {exc}", "data/drive_source.json")
    if not str(config.get("folder_url", "")).strip():
        fail("drive_source.json does not contain folder_url", "data/drive_source.json")


def validate_project_files() -> None:
    missing = [relative for relative in REQUIRED_PROJECT_FILES if not (ROOT / relative).is_file()]
    if missing:
        for relative in missing:
            github_error(f"Required project file is missing: {relative}", relative)
        raise SystemExit(
            "The uploaded project package is incomplete. Upload the complete V2 patch or full project before rerunning."
        )


def main() -> None:
    validate_project_files()
    candidates = master_candidates()
    if not candidates:
        fail(
            "Required Zone Distribution workbook is missing. Upload "
            "'Zone Distribution Jul 2026 w location type.xlsx' to data/master/, commit it, and rerun this workflow.",
            "data/master/",
        )
    if len(candidates) > 1:
        names = ", ".join(p.name for p in candidates)
        fail(
            f"Multiple master workbooks found ({names}). Keep exactly one current Zone Distribution workbook in data/master/.",
            "data/master/",
        )
    validate_master(candidates[0])
    validate_drive_config()
    print(f"Master workbook OK: {candidates[0].name} ({candidates[0].stat().st_size:,} bytes)")
    print("Google Drive source configuration OK.")


if __name__ == "__main__":
    main()
