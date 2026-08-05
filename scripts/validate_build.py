#!/usr/bin/env python3
"""Fail deployment when the generated dashboard is incomplete or internally inconsistent."""
from __future__ import annotations
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "processed" / "dashboard_data.json"
MASTER_DIR = ROOT / "data" / "master"

if not DATA.exists():
    raise SystemExit("processed/dashboard_data.json was not generated")
payload = json.loads(DATA.read_text(encoding="utf-8"))
meta = payload.get("meta", {})
regions = payload.get("regions", [])
zones = payload.get("zones", [])
outlets = payload.get("outlets", [])
errors = []
if not list(MASTER_DIR.glob("*.xlsx")):
    errors.append("Zone Distribution master workbook is missing from data/master")
if not regions: errors.append("No Regional Heads were generated")
if not zones: errors.append("No zones were generated")
if not outlets: errors.append("No outlets were generated")
if meta.get("total_rows_used", 0) <= 0: errors.append("No performance rows were used")
if meta.get("region_count") != len(regions): errors.append("Regional Head count mismatch")
if meta.get("zone_count") != len(zones): errors.append("Zone count mismatch")
if meta.get("outlet_count") != len(outlets): errors.append("Outlet count mismatch")
master_count = meta.get("coverage", {}).get("master_outlets", 0)
if master_count and len(outlets) < master_count:
    errors.append(f"Only {len(outlets)} output outlets for {master_count} master outlets")
for row in outlets:
    sales = row.get("metrics", {}).get("sales", {})
    if sales.get("last") == 0 and sales.get("this", 0) > 0 and (sales.get("status") != "new" or sales.get("growth") is not None):
        errors.append(f"Zero-last logic failed for outlet {row.get('outlet_code')}")
        break
if errors:
    raise SystemExit("BUILD VALIDATION FAILED:\n- " + "\n- ".join(errors))
print(f"Validated: {len(regions)} Regional Heads, {len(zones)} zones, {len(outlets)} outlets, {meta.get('total_rows_used', 0):,} rows.")
