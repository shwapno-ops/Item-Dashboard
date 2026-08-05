#!/usr/bin/env python3
"""Build compact GitHub Pages JSON from Zone Distribution and performance XLSX files.

Key guarantees:
- The Regional Head / Zonal / Outlet hierarchy is seeded from the complete master file.
- Master entities remain visible even when no performance row exists.
- Sales Last = 0 is classified as ``new`` and growth % is left null.
- The correct worksheet/header row is detected instead of blindly reading sheet 1 row 1.
- Uses only Python standard library.
"""
from __future__ import annotations

import json
import math
import re
import shutil
import sys
import zipfile
import zlib
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
PERF_DIR = ROOT / "data" / "performance"
MASTER_DIR = ROOT / "data" / "master"
CONFIG_PATH = ROOT / "data" / "config.json"
DRIVE_MANIFEST_PATH = PERF_DIR / "drive_manifest.json"
OUTPUT_PATH = ROOT / "processed" / "dashboard_data.json"
SKU_CHUNK_DIR = ROOT / "processed" / "sku_chunks"
SKU_BUCKETS = 64

MAIN_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"

PERFORMANCE_HEADERS = [
    "Outlet Code", "Outlet Name", "Regional Head ID", "Regional Head HR Name",
    "Zonal ID", "Zonal Name", "SKU", "SKU Name", "Division", "Cat 01", "Cat 03",
    "Sales Qty This", "Sales Qty Last", "Sales This", "Sales Last",
    "FF This", "FF Last", "Basket Size This", "Basket Size Last", "GPV This", "GPV Last",
]
MASTER_REQUIRED_ANY = ["Outlet Code", "Outlet Name", "Regional Head HR Name", "Zonal Name"]

HEADER_ALIASES = {
    # identifiers
    "code": "Outlet Code", "outlet code": "Outlet Code", "store code": "Outlet Code",
    "outlet": "Outlet Name", "outlet name": "Outlet Name", "store name": "Outlet Name",
    "regional head id": "Regional Head ID", "rho id": "Regional Head ID", "leader id": "Regional Head ID",
    "regional head hr name": "Regional Head HR Name", "regional head name": "Regional Head HR Name",
    "regional head": "Regional Head HR Name", "rho": "Regional Head HR Name", "rho name": "Regional Head HR Name",
    "leader": "Regional Head HR Name", "leader name": "Regional Head HR Name",
    "zonal id": "Zonal ID", "zonal employee id": "Zonal ID",
    "zonal": "Zonal Name", "zonal name": "Zonal Name", "zonal hr name": "Zonal Name",
    "zone": "Zonal Name", "zone name": "Zonal Name",
    # product/performance
    "sku": "SKU", "article": "SKU", "article code": "SKU",
    "sku name": "SKU Name", "article name": "SKU Name",
    "division": "Division", "cat 01": "Cat 01", "cat01": "Cat 01",
    "cat 03": "Cat 03", "cat03": "Cat 03",
    "sales qty this": "Sales Qty This", "sales quantity this": "Sales Qty This",
    "sales qty last": "Sales Qty Last", "sales quantity last": "Sales Qty Last",
    "sales this": "Sales This", "sales current": "Sales This",
    "sales last": "Sales Last", "sales ly": "Sales Last",
    "ff this": "FF This", "footfall this": "FF This",
    "ff last": "FF Last", "footfall last": "FF Last",
    "basket size this": "Basket Size This", "basket this": "Basket Size This",
    "basket size last": "Basket Size Last", "basket last": "Basket Size Last",
    "gpv this": "GPV This", "gp value this": "GPV This",
    "gpv last": "GPV Last", "gp value last": "GPV Last",
    # master attributes
    "sft": "SFT", "sqft": "SFT", "sq ft": "SFT",
    "format": "Format", "outlet format": "Format",
    "district": "District", "status": "Status",
    "ownership": "Status", "ownership status": "Status",
    "pnp non pnp status": "PNP Non PNP status", "pnp status": "PNP Non PNP status",
    "location type": "Location Type", "population density": "Population Density",
    "income level": "Income Level", "income level ": "Income Level",
    "outlet status": "Operational Status", "operational status": "Operational Status",
    "active status": "Operational Status", "store status": "Operational Status",
}

ADD_FIELDS = (
    "sales_qty_this", "sales_qty_last", "sales_this", "sales_last",
    "ff_this", "ff_last", "gpv_this", "gpv_last",
)


def clean_text(value) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value).strip())


def header_key(value) -> str:
    return re.sub(r"[^a-z0-9]+", " ", clean_text(value).lower()).strip()


def canonical_header(value: str) -> str:
    raw = clean_text(value)
    return HEADER_ALIASES.get(header_key(raw), raw)


def safe_float(value) -> float:
    if value is None or clean_text(value) == "":
        return 0.0
    try:
        number = float(str(value).replace(",", "").replace("৳", "").strip())
        return number if math.isfinite(number) else 0.0
    except (ValueError, TypeError):
        return 0.0


def column_index(cell_ref: str) -> int:
    match = re.match(r"([A-Z]+)", cell_ref)
    if not match:
        return 0
    number = 0
    for char in match.group(1):
        number = number * 26 + ord(char) - 64
    return number - 1


def shared_strings(zf: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = ET.parse(zf.open("xl/sharedStrings.xml")).getroot()
    return ["".join(node.text or "" for node in item.iter(MAIN_NS + "t")) for item in root.findall(MAIN_NS + "si")]


def workbook_sheets(zf: zipfile.ZipFile) -> list[tuple[str, str]]:
    wb_root = ET.parse(zf.open("xl/workbook.xml")).getroot()
    rel_root = ET.parse(zf.open("xl/_rels/workbook.xml.rels")).getroot()
    rels = {rel.attrib.get("Id"): rel.attrib.get("Target", "") for rel in rel_root.findall(PKG_REL_NS + "Relationship")}
    result = []
    sheets = wb_root.find(MAIN_NS + "sheets")
    for sheet in list(sheets) if sheets is not None else []:
        rid = sheet.attrib.get(REL_NS + "id")
        target = rels.get(rid, "").lstrip("/")
        if target and not target.startswith("xl/"):
            target = "xl/" + target
        if target:
            result.append((sheet.attrib.get("name", "Sheet"), target))
    return result


def iter_sheet_rows(path: Path, sheet_path: str):
    with zipfile.ZipFile(path) as zf:
        strings = shared_strings(zf)
        with zf.open(sheet_path) as stream:
            for _, elem in ET.iterparse(stream, events=("end",)):
                if elem.tag != MAIN_NS + "row":
                    continue
                cells = {}
                for cell in elem.findall(MAIN_NS + "c"):
                    idx = column_index(cell.attrib.get("r", "A1"))
                    cell_type = cell.attrib.get("t")
                    if cell_type == "inlineStr":
                        value = "".join(node.text or "" for node in cell.iter(MAIN_NS + "t"))
                    else:
                        value_node = cell.find(MAIN_NS + "v")
                        value = "" if value_node is None else (value_node.text or "")
                        if cell_type == "s" and value != "":
                            try:
                                value = strings[int(value)]
                            except (ValueError, IndexError):
                                value = ""
                        elif cell_type == "b":
                            value = "TRUE" if value == "1" else "FALSE"
                    cells[idx] = value
                if cells:
                    max_idx = max(cells)
                    yield [cells.get(i, "") for i in range(max_idx + 1)]
                else:
                    yield []
                elem.clear()


def detect_table(path: Path, required_headers: list[str], preferred_names: tuple[str, ...] = ()) -> tuple[str, str, int, list[str]]:
    required = set(required_headers)
    best = None
    with zipfile.ZipFile(path) as zf:
        sheets = workbook_sheets(zf)
    for sheet_name, sheet_path in sheets:
        preferred_score = 25 if any(p.lower() in sheet_name.lower() for p in preferred_names) else 0
        for row_number, raw in enumerate(iter_sheet_rows(path, sheet_path), start=1):
            if row_number > 45:
                break
            headers = [canonical_header(v) for v in raw]
            matches = len(required.intersection(headers))
            nonblank = sum(bool(clean_text(v)) for v in headers)
            score = matches * 100 + preferred_score + min(nonblank, 40)
            candidate = (score, matches, sheet_name, sheet_path, row_number, headers)
            if best is None or candidate[:2] > best[:2]:
                best = candidate
    if not best:
        raise ValueError(f"{path.name}: workbook has no readable worksheets")
    _, matches, sheet_name, sheet_path, row_number, headers = best
    minimum = min(3, len(required_headers))
    if matches < minimum:
        raise ValueError(f"{path.name}: could not find a valid header row (best match {matches}/{len(required_headers)})")
    return sheet_name, sheet_path, row_number, headers


def read_table(path: Path, required_headers: list[str], preferred_names: tuple[str, ...] = ()):
    sheet_name, sheet_path, header_row, headers = detect_table(path, required_headers, preferred_names)

    def records():
        for row_number, row in enumerate(iter_sheet_rows(path, sheet_path), start=1):
            if row_number <= header_row:
                continue
            if not any(clean_text(v) for v in row):
                continue
            padded = row + [""] * max(0, len(headers) - len(row))
            yield row_number, {headers[i]: padded[i] if i < len(padded) else "" for i in range(len(headers)) if headers[i]}

    return headers, records(), sheet_name, header_row


def new_agg() -> dict[str, float]:
    return {field: 0.0 for field in ADD_FIELDS}


def add_metrics(target: dict[str, float], values: dict[str, float]) -> None:
    for field in ADD_FIELDS:
        target[field] += values[field]


def row_metrics(row: dict[str, str]) -> dict[str, float]:
    return {
        "sales_qty_this": safe_float(row.get("Sales Qty This")),
        "sales_qty_last": safe_float(row.get("Sales Qty Last")),
        "sales_this": safe_float(row.get("Sales This")),
        "sales_last": safe_float(row.get("Sales Last")),
        "ff_this": safe_float(row.get("FF This")),
        "ff_last": safe_float(row.get("FF Last")),
        "gpv_this": safe_float(row.get("GPV This")),
        "gpv_last": safe_float(row.get("GPV Last")),
    }


def metric_result(this_value: float, last_value: float) -> dict:
    this_value = 0.0 if abs(this_value) < 1e-9 else this_value
    last_value = 0.0 if abs(last_value) < 1e-9 else last_value
    diff = this_value - last_value
    note = ""
    if last_value == 0:
        if this_value > 0:
            status, growth = "new", None
            note = "Growth percentage is not calculated because last-year value is zero."
        elif this_value < 0:
            status, growth = "degrowth", None
            note = "Growth percentage is not calculated because last-year value is zero."
        else:
            status, growth = "flat", 0.0
    else:
        growth = diff / abs(last_value) * 100.0
        if this_value == 0 and last_value > 0:
            status = "inactive"
        elif growth > 0.000001:
            status = "growth"
        elif growth < -0.000001:
            status = "degrowth"
        else:
            status = "flat"
    return {
        "this": round(this_value, 4), "last": round(last_value, 4), "diff": round(diff, 4),
        "growth": None if growth is None else round(growth, 4), "status": status, "growth_note": note,
    }


def finalize_metrics(agg: dict[str, float]) -> dict:
    basket_this = agg["sales_this"] / agg["ff_this"] if agg["ff_this"] else 0.0
    basket_last = agg["sales_last"] / agg["ff_last"] if agg["ff_last"] else 0.0
    return {
        "sales": metric_result(agg["sales_this"], agg["sales_last"]),
        "sales_qty": metric_result(agg["sales_qty_this"], agg["sales_qty_last"]),
        "ff": metric_result(agg["ff_this"], agg["ff_last"]),
        "basket": metric_result(basket_this, basket_last),
        "gpv": metric_result(agg["gpv_this"], agg["gpv_last"]),
    }


def operational_active(value: str) -> bool:
    v = header_key(value)
    if not v:
        return True
    inactive_tokens = ("inactive", "closed", "permanently closed", "temporarily closed", "not active", "suspended")
    return not any(token in v for token in inactive_tokens)


def load_master(master_file: Path):
    headers, records, sheet_name, header_row = read_table(master_file, MASTER_REQUIRED_ANY, ("final_zone", "final zone", "zone dis", "distribution"))
    by_code, duplicates = {}, []
    for row_number, row in records:
        code = clean_text(row.get("Outlet Code"))
        if not code:
            continue
        operational_status = clean_text(row.get("Operational Status"))
        item = {
            "outlet_code": code,
            "outlet_name": clean_text(row.get("Outlet Name")),
            "regional_id": clean_text(row.get("Regional Head ID")),
            "regional_name": clean_text(row.get("Regional Head HR Name")),
            "zonal_id": clean_text(row.get("Zonal ID")),
            "zonal_name": clean_text(row.get("Zonal Name")),
            "sft": round(safe_float(row.get("SFT")), 2),
            "format": clean_text(row.get("Format")),
            "geo_division": clean_text(row.get("Division")),
            "district": clean_text(row.get("District")),
            "pnp_status": clean_text(row.get("PNP Non PNP status")),
            "ownership_status": clean_text(row.get("Status")),
            "operational_status": operational_status,
            "is_active": operational_active(operational_status),
            "location_type": clean_text(row.get("Location Type")),
            "population_density": clean_text(row.get("Population Density")),
            "income_level": clean_text(row.get("Income Level")),
        }
        if code in by_code:
            duplicates.append({"outlet_code": code, "row": row_number})
        else:
            by_code[code] = item
    return headers, by_code, duplicates, sheet_name, header_row


def raw_array(agg: dict[str, float]) -> list[float]:
    return [round(agg[field], 4) for field in ADD_FIELDS]


def sku_bucket(sku: str) -> str:
    return f"{zlib.crc32(sku.encode('utf-8')) % SKU_BUCKETS:02d}"


def select_sku_drivers(aggregates: dict, top_n: int = 50) -> dict:
    rows = []
    for item in aggregates.values():
        rows.append({
            "sku": item["sku"], "sku_name": item["sku_name"], "division": item["division"],
            "cat01": item["cat01"], "cat03": item["cat03"], "metrics": finalize_metrics(item["agg"]),
        })
    positive = sorted((r for r in rows if r["metrics"]["sales"]["diff"] > 0), key=lambda r: r["metrics"]["sales"]["diff"], reverse=True)[:top_n]
    negative = sorted((r for r in rows if r["metrics"]["sales"]["diff"] < 0), key=lambda r: r["metrics"]["sales"]["diff"])[:top_n]
    sales = sorted(rows, key=lambda r: r["metrics"]["sales"]["this"], reverse=True)[:top_n]
    return {"positive": positive, "negative": negative, "top_sales": sales}


def main() -> int:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8")) if CONFIG_PATH.exists() else {}
    drive_manifest = json.loads(DRIVE_MANIFEST_PATH.read_text(encoding="utf-8")) if DRIVE_MANIFEST_PATH.exists() else {}
    perf_files = sorted(PERF_DIR.glob("*.xlsx"))
    master_files = sorted(MASTER_DIR.glob("*.xlsx"))
    if not perf_files:
        raise SystemExit("No performance .xlsx files found in data/performance")
    if not master_files:
        raise SystemExit("No zone distribution .xlsx file found in data/master")

    master_headers, master, master_duplicates, master_sheet, master_header_row = load_master(master_files[0])
    overall = new_agg()
    region_totals, zone_totals, outlet_totals = defaultdict(new_agg), defaultdict(new_agg), defaultdict(new_agg)
    region_meta, zone_meta, outlet_meta = {}, {}, {}
    region_outlets, zone_outlets = defaultdict(set), defaultdict(set)
    category_cube, category_meta = defaultdict(new_agg), {}
    sku_global, sku_region, sku_zone, sku_outlet = {}, defaultdict(dict), defaultdict(dict), defaultdict(dict)

    # Seed complete hierarchy from Zone Distribution before reading any sales workbook.
    for code, item in master.items():
        region_key = item["regional_id"] or item["regional_name"] or "UNMAPPED-REGION"
        zone_key = f"{region_key}|{item['zonal_id'] or item['zonal_name'] or 'UNMAPPED-ZONE'}"
        region_meta.setdefault(region_key, {
            "regional_id": item["regional_id"], "regional_name": item["regional_name"] or "Unmapped Regional Head",
        })
        zone_meta.setdefault(zone_key, {
            "zone_key": zone_key, "zonal_id": item["zonal_id"], "zonal_name": item["zonal_name"] or "Unmapped Zone",
            "regional_id": item["regional_id"], "regional_name": item["regional_name"], "regional_key": region_key,
        })
        outlet_meta[code] = {**item, "regional_key": region_key, "zone_key": zone_key, "has_performance": False}
        outlet_totals[code] = new_agg()
        region_totals[region_key] = region_totals[region_key]
        zone_totals[zone_key] = zone_totals[zone_key]
        region_outlets[region_key].add(code)
        zone_outlets[zone_key].add(code)

    seen_records, performance_outlets, missing_master = set(), set(), set()
    file_stats, duplicate_records, hierarchy_mismatches, warnings = [], [], [], []
    invalid_rows, mismatch_seen = 0, set()

    for perf_file in perf_files:
        try:
            headers, records, sheet_name, header_row = read_table(perf_file, PERFORMANCE_HEADERS, ("data", "sku", "performance", "sales"))
        except Exception as exc:
            warnings.append({"type": "unreadable_workbook", "file": perf_file.name, "details": str(exc)})
            continue
        missing_headers = [h for h in PERFORMANCE_HEADERS if h not in headers]
        if missing_headers:
            warnings.append({"type": "missing_headers", "file": perf_file.name, "details": missing_headers})
            file_stats.append({"file": perf_file.name, "sheet_name": sheet_name, "header_row": header_row, "rows_read": 0, "rows_used": 0, "outlets": 0, "missing_headers": missing_headers})
            continue
        rows_read = rows_used = 0
        file_outlets = set()
        for row_number, row in records:
            rows_read += 1
            outlet_code, sku = clean_text(row.get("Outlet Code")), clean_text(row.get("SKU"))
            if not outlet_code or not sku:
                invalid_rows += 1
                continue
            unique_key = (outlet_code, sku)
            if unique_key in seen_records:
                if len(duplicate_records) < 1000:
                    duplicate_records.append({"file": perf_file.name, "row": row_number, "outlet_code": outlet_code, "sku": sku})
                continue
            seen_records.add(unique_key)
            rows_used += 1
            performance_outlets.add(outlet_code)
            file_outlets.add(outlet_code)

            master_row = master.get(outlet_code)
            perf_region_id = clean_text(row.get("Regional Head ID"))
            perf_region_name = clean_text(row.get("Regional Head HR Name"))
            perf_zone_id = clean_text(row.get("Zonal ID"))
            perf_zone_name = clean_text(row.get("Zonal Name"))
            if master_row:
                region_id, region_name = master_row["regional_id"] or perf_region_id, master_row["regional_name"] or perf_region_name
                zone_id, zone_name = master_row["zonal_id"] or perf_zone_id, master_row["zonal_name"] or perf_zone_name
                outlet_name = master_row["outlet_name"] or clean_text(row.get("Outlet Name"))
                mismatch = {}
                if perf_region_id and master_row["regional_id"] and perf_region_id != master_row["regional_id"]:
                    mismatch["regional_id"] = [perf_region_id, master_row["regional_id"]]
                if perf_zone_id and master_row["zonal_id"] and perf_zone_id != master_row["zonal_id"]:
                    mismatch["zonal_id"] = [perf_zone_id, master_row["zonal_id"]]
                if mismatch and outlet_code not in mismatch_seen and len(hierarchy_mismatches) < 1000:
                    mismatch_seen.add(outlet_code)
                    hierarchy_mismatches.append({"outlet_code": outlet_code, **mismatch})
            else:
                missing_master.add(outlet_code)
                region_id, region_name, zone_id, zone_name = perf_region_id, perf_region_name, perf_zone_id, perf_zone_name
                outlet_name = clean_text(row.get("Outlet Name"))

            region_key = region_id or region_name or "UNMAPPED-REGION"
            zone_key = f"{region_key}|{zone_id or zone_name or 'UNMAPPED-ZONE'}"
            values = row_metrics(row)
            add_metrics(overall, values)
            add_metrics(region_totals[region_key], values)
            add_metrics(zone_totals[zone_key], values)
            add_metrics(outlet_totals[outlet_code], values)

            region_meta.setdefault(region_key, {"regional_id": region_id, "regional_name": region_name or "Unmapped Regional Head"})
            zone_meta.setdefault(zone_key, {"zone_key": zone_key, "zonal_id": zone_id, "zonal_name": zone_name or "Unmapped Zone", "regional_id": region_id, "regional_name": region_name, "regional_key": region_key})
            if outlet_code not in outlet_meta:
                outlet_meta[outlet_code] = {
                    "outlet_code": outlet_code, "outlet_name": outlet_name, "regional_id": region_id, "regional_name": region_name,
                    "regional_key": region_key, "zonal_id": zone_id, "zonal_name": zone_name, "zone_key": zone_key,
                    "is_active": True, "has_performance": True,
                }
            else:
                outlet_meta[outlet_code]["has_performance"] = True
            region_outlets[region_key].add(outlet_code)
            zone_outlets[zone_key].add(outlet_code)

            division = clean_text(row.get("Division")) or "Unspecified"
            cat01 = clean_text(row.get("Cat 01")) or "Unspecified"
            cat03 = clean_text(row.get("Cat 03")) or "Unspecified"
            category_key = (outlet_code, division, cat01, cat03)
            add_metrics(category_cube[category_key], values)
            category_meta[category_key] = {"outlet_code": outlet_code, "regional_key": region_key, "zone_key": zone_key, "division": division, "cat01": cat01, "cat03": cat03}

            sku_name = clean_text(row.get("SKU Name"))
            payload = {"sku": sku, "sku_name": sku_name, "division": division, "cat01": cat01, "cat03": cat03}
            for collection, key in ((sku_global, sku), (sku_region[region_key], sku), (sku_zone[zone_key], sku), (sku_outlet[outlet_code], sku)):
                if key not in collection:
                    collection[key] = {**payload, "agg": new_agg()}
                add_metrics(collection[key]["agg"], values)

        file_stats.append({"file": perf_file.name, "sheet_name": sheet_name, "header_row": header_row, "rows_read": rows_read, "rows_used": rows_used, "outlets": len(file_outlets), "missing_headers": missing_headers})

    regions = []
    for key in sorted(region_meta, key=lambda k: region_meta[k]["regional_name"]):
        codes = region_outlets[key]
        regions.append({
            **region_meta[key], "regional_key": key, "outlet_count": len(codes),
            "active_outlet_count": sum(outlet_meta[c].get("is_active", True) for c in codes),
            "performance_outlet_count": sum(outlet_meta[c].get("has_performance", False) for c in codes),
            "zone_count": len({outlet_meta[c]["zone_key"] for c in codes}), "metrics": finalize_metrics(region_totals[key]),
        })
    zones = []
    for key in sorted(zone_meta, key=lambda k: (zone_meta[k].get("regional_name", ""), zone_meta[k]["zonal_name"])):
        codes = zone_outlets[key]
        zones.append({
            **zone_meta[key], "outlet_count": len(codes),
            "active_outlet_count": sum(outlet_meta[c].get("is_active", True) for c in codes),
            "performance_outlet_count": sum(outlet_meta[c].get("has_performance", False) for c in codes),
            "metrics": finalize_metrics(zone_totals[key]),
        })
    outlets = [{**outlet_meta[code], "metrics": finalize_metrics(outlet_totals[code])} for code in sorted(outlet_meta)]
    categories = [{**category_meta[key], "values": raw_array(agg)} for key, agg in category_cube.items()]

    sku_drivers = {
        "overall": select_sku_drivers(sku_global),
        "regions": {key: select_sku_drivers(values) for key, values in sku_region.items()},
        "zones": {key: select_sku_drivers(values) for key, values in sku_zone.items()},
        "outlets": {key: select_sku_drivers(values) for key, values in sku_outlet.items()},
    }

    sku_hierarchy = {}
    for sku, item in sku_global.items():
        sku_hierarchy[sku] = {"sku": sku, "sku_name": item["sku_name"], "division": item["division"], "cat01": item["cat01"], "cat03": item["cat03"], "overall": raw_array(item["agg"]), "regions": {}, "zones": {}, "outlets": {}}
    for region_key, collection in sku_region.items():
        for sku, item in collection.items(): sku_hierarchy[sku]["regions"][region_key] = raw_array(item["agg"])
    for zone_key, collection in sku_zone.items():
        for sku, item in collection.items(): sku_hierarchy[sku]["zones"][zone_key] = raw_array(item["agg"])
    for outlet_code, collection in sku_outlet.items():
        for sku, item in collection.items(): sku_hierarchy[sku]["outlets"][outlet_code] = raw_array(item["agg"])

    chunks, sku_catalog = defaultdict(dict), []
    for sku, item in sorted(sku_hierarchy.items()):
        bucket = sku_bucket(sku)
        chunks[bucket][sku] = item
        sku_catalog.append({"sku": sku, "sku_name": item["sku_name"], "division": item["division"], "cat01": item["cat01"], "cat03": item["cat03"], "bucket": bucket, "values": item["overall"]})
    if SKU_CHUNK_DIR.exists(): shutil.rmtree(SKU_CHUNK_DIR)
    SKU_CHUNK_DIR.mkdir(parents=True, exist_ok=True)
    for bucket in [f"{i:02d}" for i in range(SKU_BUCKETS)]:
        (SKU_CHUNK_DIR / f"{bucket}.json").write_text(json.dumps({"skus": chunks.get(bucket, {})}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    master_without_performance = sorted(set(master) - performance_outlets)
    coverage = {
        "master_outlets": len(master), "performance_outlets": len(performance_outlets),
        "matched_outlets": len(performance_outlets - missing_master), "performance_missing_master": len(missing_master),
        "master_without_performance": len(master_without_performance),
        "coverage_pct": round((len(performance_outlets - missing_master) / len(master) * 100.0) if master else 0.0, 2),
    }
    result = {
        "config": config,
        "meta": {
            "schema_version": 2, "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "performance_files": file_stats, "master_file": master_files[0].name, "master_sheet": master_sheet,
            "master_header_row": master_header_row, "total_rows_read": sum(x["rows_read"] for x in file_stats),
            "total_rows_used": sum(x["rows_used"] for x in file_stats), "invalid_rows": invalid_rows,
            "duplicate_records": len(duplicate_records), "region_count": len(regions), "zone_count": len(zones),
            "outlet_count": len(outlets), "active_outlet_count": sum(o.get("is_active", True) for o in outlets),
            "performance_outlet_count": sum(o.get("has_performance", False) for o in outlets),
            "category_cube_rows": len(categories), "sku_count": len(sku_catalog), "sku_chunk_count": SKU_BUCKETS,
            "coverage": coverage,
            "aggregation_note": "Sales, Sales Qty, FF and GPV are summed. Basket Size is recalculated as aggregated Sales divided by aggregated FF.",
            "zero_last_note": "When last-year value is zero and current value is positive, status is New (LY=0); growth percentage is null because division by zero is undefined.",
            "hierarchy_note": "Regional Heads, Zones and Outlets are seeded from the complete Zone Distribution master before performance files are aggregated.",
            "drive_source": drive_manifest,
        },
        "overall": {"metrics": finalize_metrics(overall)},
        "regions": regions, "zones": zones, "outlets": outlets, "categories": categories,
        "sku_catalog": sku_catalog, "sku_drivers": sku_drivers,
        "data_quality": {
            "master_duplicate_mappings": master_duplicates[:1000], "duplicate_performance_records": duplicate_records,
            "performance_outlets_missing_master": sorted(missing_master)[:1000],
            "master_outlets_without_performance_sample": master_without_performance[:1000],
            "hierarchy_mismatches": hierarchy_mismatches, "warnings": warnings,
        },
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Built {OUTPUT_PATH}")
    print(f"Master hierarchy: {len(regions)} Regional Heads, {len(zones)} zones, {len(outlets)} outlets")
    print(f"Performance coverage: {len(performance_outlets)} outlets; rows used: {result['meta']['total_rows_used']:,}")
    print(f"SKU catalog: {len(sku_catalog):,}; output: {OUTPUT_PATH.stat().st_size / 1024 / 1024:.2f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
