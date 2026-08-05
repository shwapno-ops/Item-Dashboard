# Required Zone Distribution master

Before running the GitHub Actions workflow, place the **actual Excel workbook** below in this folder:

`Zone Distribution Jul 2026 w location type.xlsx`

Required final path:

`data/master/Zone Distribution Jul 2026 w location type.xlsx`

The workbook is operational source data and is not recreated from the dashboard code. The processor uses it to seed every Regional Head, Zonal Name and Outlet, including active outlets that have no matching sales row.

Important:

- Upload the actual `.xlsx` file, not a shortcut, text placeholder or Git LFS pointer.
- Keep exactly one current Zone Distribution `.xlsx`/`.xlsm` workbook in this folder.
- After committing the workbook, run **Actions → Refresh dashboard and deploy Pages → Run workflow**.
