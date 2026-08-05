# Shwapno Item Performance Dashboard — corrected build

GitHub Pages dashboard for Regional Head, Zonal, Outlet, Category and SKU performance analysis.

## Fixed in this version

1. **Complete Regional Head and Zonal lists**  
   The build now seeds the hierarchy from `data/master/Zone Distribution Jul 2026 w location type.xlsx` before processing sales. Regional Heads, zones and outlets remain visible even when their performance workbook has no matching row.

2. **Correct worksheet detection**  
   The processor scans worksheets and the first 45 rows to locate the real header. It no longer assumes that the first worksheet and first row contain data.

3. **Sales Last = 0 rule**  
   - Current > 0 and Last = 0 → `New (LY=0)`
   - Growth % → blank / null because division by zero is undefined
   - Difference → Current − Last, therefore equal to Current
   - Current = 0 and Last > 0 → `Inactive`

4. **Expanded Performance Summary**  
   Includes Active Outlets, Sales-covered Outlets, Total Master Outlets, Growing, De-growing and New outlets.

5. **Working drill-through actions**  
   `View all` buttons now open Outlet Analysis and apply the selected performance status.

6. **Power BI / Excel-style tables**  
   Every table supports:
   - click header to sort ascending/descending
   - per-column searchable multi-select filters
   - smallest-to-largest and largest-to-smallest sorting
   - drag-and-drop column reordering
   - global table search
   - page-size selection and pagination
   - CSV export of the filtered/sorted result

7. **SKU & Category improvements**  
   Separate `SKU Growth Drivers` and `SKU De-growth Drivers` tables, plus complete interactive Category and SKU tables.

8. **Reports & Export repaired**  
   CSV and JSON files are generated directly in the browser, so downloads work on GitHub Pages without a backend.

## Deploy over the current repository

1. Extract this ZIP.
2. Upload its contents to the **root** of `shwapno-ops/Item-Dashboard`.
3. **Keep the existing master workbook** at:
   `data/master/Zone Distribution Jul 2026 w location type.xlsx`
4. Commit to the `main` branch.
5. Open **Actions → Refresh data and deploy Pages → Run workflow**.
6. In repository **Settings → Pages**, set Source to **GitHub Actions**.

The workflow downloads the 11 performance workbooks from the configured public Google Drive folder, rebuilds the processed data, validates hierarchy completeness and zero-last-year logic, commits the compact JSON, and deploys GitHub Pages.

## Data architecture

- Raw performance Excel files: temporary GitHub Actions runner only
- Zone Distribution master: retained in `data/master`
- Published site: compact JSON under `processed/`
- No large raw sales workbook is exposed through GitHub Pages

## Local preview

```bash
python -m http.server 8000
```

Open `http://localhost:8000/`.

The included processed JSON is an empty fallback shell. Live figures appear after the first successful workflow run.

## Required deployment preflight

The repository must contain the real workbook at:

`data/master/Zone Distribution Jul 2026 w location type.xlsx`

The workflow intentionally fails before processing when this source file is absent or invalid. See `ACTION_FAILURE_FIX.md` for the corrected deployment sequence.

## GitHub Actions V2 package integrity check

The deployment workflow verifies that the downloader, processor, validator, static assets, and configuration files are present before running. For an existing repository, use the V2 Actions patch and upload its contents directly at the repository root. Keep the current Zone Distribution workbook in `data/master/`.
