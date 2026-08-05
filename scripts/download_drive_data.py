#!/usr/bin/env python3
"""Download public performance workbooks into the temporary Actions workspace."""
from __future__ import annotations
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_CONFIG = ROOT / "data" / "drive_source.json"
PERFORMANCE_DIR = ROOT / "data" / "performance"
TEMP_DIR = ROOT / ".drive_download"
MANIFEST_PATH = PERFORMANCE_DIR / "drive_manifest.json"


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def unique_destination(path: Path, used_names: set[str]) -> str:
    name = path.name
    if name.lower() not in used_names:
        used_names.add(name.lower())
        return name
    stem, suffix = path.stem, path.suffix
    parent = path.parent.name.replace(" ", "_") or "drive"
    candidate = f"{stem}__{parent}{suffix}"
    counter = 2
    while candidate.lower() in used_names:
        candidate = f"{stem}__{parent}_{counter}{suffix}"
        counter += 1
    used_names.add(candidate.lower())
    return candidate


def main() -> None:
    if not SOURCE_CONFIG.exists():
        fail(f"Missing configuration file: {SOURCE_CONFIG}")
    config = json.loads(SOURCE_CONFIG.read_text(encoding="utf-8"))
    folder_url = str(config.get("folder_url", "")).strip()
    if not folder_url:
        fail("drive_source.json does not contain folder_url")
    allowed = {str(ext).lower() for ext in config.get("allowed_extensions", [".xlsx"])}
    expected = int(config.get("expected_file_count", 0) or 0)
    strict = bool(config.get("strict_file_count", False))

    shutil.rmtree(TEMP_DIR, ignore_errors=True)
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    PERFORMANCE_DIR.mkdir(parents=True, exist_ok=True)
    for old in PERFORMANCE_DIR.iterdir():
        if old.is_file() and (old.suffix.lower() in allowed or old.name == MANIFEST_PATH.name):
            old.unlink()

    command = [sys.executable, "-m", "gdown", folder_url, "-O", str(TEMP_DIR), "--folder"]
    print("Downloading Google Drive performance folder:", folder_url)
    try:
        subprocess.run(command, check=True)
    except subprocess.CalledProcessError as exc:
        fail(f"Google Drive download failed with exit code {exc.returncode}. Confirm folder sharing is 'Anyone with the link – Viewer'.")

    downloaded = sorted(p for p in TEMP_DIR.rglob("*") if p.is_file() and p.suffix.lower() in allowed and not p.name.startswith("~$"))
    if not downloaded:
        fail("No supported Excel workbooks were downloaded.")

    used_names, manifest_files = set(), []
    total_bytes = 0
    for source in downloaded:
        destination = PERFORMANCE_DIR / unique_destination(source, used_names)
        shutil.copy2(source, destination)
        size = destination.stat().st_size
        total_bytes += size
        manifest_files.append({"file": destination.name, "source_relative_path": str(source.relative_to(TEMP_DIR)), "size_bytes": size})

    count = len(manifest_files)
    if expected and count != expected:
        message = f"Expected {expected} workbooks, but downloaded {count}."
        if strict:
            fail(message)
        print("WARNING:", message)

    manifest = {
        "provider": config.get("provider", "Google Drive"),
        "folder_name": config.get("folder_name", "Performance workbooks"),
        "folder_id": config.get("folder_id", ""),
        "folder_url": folder_url,
        "expected_file_count": expected,
        "downloaded_file_count": count,
        "total_bytes": total_bytes,
        "downloaded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "files": manifest_files,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Downloaded {count} workbook(s), {total_bytes / 1024 / 1024:.1f} MB total.")
    shutil.rmtree(TEMP_DIR, ignore_errors=True)


if __name__ == "__main__":
    main()
