(() => {
  'use strict';

  const ALL = '__all__';
  const PAGE_SIZE = 25;
  const SKU_CHUNK_FALLBACK_COUNT = 64;

  const METRICS = {
    sales: { label: 'Sales', thisKey: 'sales_this', lastKey: 'sales_last', money: true },
    sales_qty: { label: 'Sales Qty', thisKey: 'sales_qty_this', lastKey: 'sales_qty_last' },
    ff: { label: 'Footfall', thisKey: 'ff_this', lastKey: 'ff_last' },
    basket: { label: 'Basket Size', money: true, derived: true },
    gpv: { label: 'GPV', thisKey: 'gpv_this', lastKey: 'gpv_last', money: true }
  };

  const NAV = [
    ['executive', '◫', 'Executive Summary'],
    ['leader', '◎', 'Regional Head'],
    ['zonal', '⌾', 'Zonal Analysis'],
    ['outlet', '⌂', 'Outlet Analysis'],
    ['sku', '▦', 'SKU & Category'],
    ['detail', '≡', 'Detailed Data'],
    ['quality', '✓', 'Data Quality'],
    ['reports', '⇩', 'Reports & Export']
  ];

  const PAGE_META = {
    executive: ['Executive Summary', 'Network performance, active outlet coverage and growth status.'],
    leader: ['Regional Head Performance', 'Regional Head performance under the active dashboard filters.'],
    zonal: ['Zonal Performance', 'Zonal performance under the active dashboard filters.'],
    outlet: ['Outlet Performance', 'Outlet-level current versus last-year performance with master hierarchy.'],
    sku: ['SKU & Category Analysis', 'Category and SKU performance connected to the sidebar filters.'],
    detail: ['Detailed Data', 'Searchable, sortable, filterable and exportable detailed data.'],
    quality: ['Data Quality', 'Coverage, duplicate checks, hierarchy mismatches and source diagnostics.'],
    reports: ['Reports & Export', 'Download filtered dashboard tables as CSV or JSON.']
  };

  const FILTER_KEYS = ['regional', 'zone', 'outlet', 'division', 'cat01', 'cat03'];
  const HIERARCHY_KEYS = ['regional', 'zone', 'outlet'];
  const PRODUCT_KEYS = ['division', 'cat01', 'cat03'];
  const FILTER_FIELDS = {
    regional: 'regional_key',
    zone: 'zone_key',
    outlet: 'outlet_code',
    division: 'division',
    cat01: 'cat01',
    cat03: 'cat03'
  };
  const FILTER_META = {
    regional: { label: 'Regional Head', all: 'All Regional Heads' },
    zone: { label: 'Zonal Name', all: 'All Zones' },
    outlet: { label: 'Outlet', all: 'All Outlets' },
    division: { label: 'Division', all: 'All Divisions' },
    cat01: { label: 'Cat 01', all: 'All Cat 01' },
    cat03: { label: 'Cat 03', all: 'All Cat 03' }
  };

  const state = {
    data: null,
    page: 'executive',
    metric: 'sales',
    regional: ALL,
    zone: ALL,
    outlet: ALL,
    division: ALL,
    cat01: ALL,
    cat03: ALL,
    viewStatus: ALL,
    multi: { regional: [], zone: [], outlet: [], division: [], cat01: [], cat03: [] },
    tableState: {},
    loading: false,
    skuChunks: new Map(),
    skuHierarchyCatalog: null,
    skuHierarchyPromise: null,
    skuHierarchyError: ''
  };

  const runtimeTables = new Map();
  let openFilter = null;

  const el = id => document.getElementById(id);
  const text = value => String(value ?? '').trim();
  const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
  const unique = values => [...new Set(values.filter(v => text(v) !== '').map(String))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  function compactNumber(value) {
    const n = num(value);
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    const scaled = divisor => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(abs / divisor);
    if (abs >= 10000000) return `${sign}${scaled(10000000)} Cr`;
    if (abs >= 100000) return `${sign}${scaled(100000)} Lac`;
    if (abs >= 10000) return `${sign}${scaled(1000)} K`;
    return `${sign}${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(abs)}`;
  }

  const money = value => `৳${compactNumber(value)}`;
  const pct = value => value == null ? '—' : `${num(value).toFixed(1)}%`;
  const statusLabel = status => ({
    growth: 'Growing',
    degrowth: 'De-growing',
    flat: 'Flat',
    new: 'New (LY=0)',
    inactive: 'Inactive',
    no_data: 'No data'
  }[status] || status || 'No data');
  const statusBadge = status => `<span class="status status-${esc(status || 'flat')}">${esc(statusLabel(status))}</span>`;
  const metricDef = () => METRICS[state.metric];
  const formatMetric = (value, metric = state.metric) => METRICS[metric]?.money ? money(value) : compactNumber(value);

  function dateFmt(value) {
    if (!value) return 'Not generated';
    const d = new Date(value);
    return Number.isNaN(d.valueOf()) ? String(value) : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function metricResult(thisValue, lastValue) {
    const current = Math.abs(num(thisValue)) < 1e-9 ? 0 : num(thisValue);
    const last = Math.abs(num(lastValue)) < 1e-9 ? 0 : num(lastValue);
    const diff = current - last;
    let status = 'flat';
    let growth = 0;

    if (last === 0) {
      if (current > 0) { status = 'new'; growth = null; }
      else if (current < 0) { status = 'degrowth'; growth = null; }
    } else {
      growth = diff / Math.abs(last) * 100;
      if (current === 0 && last > 0) status = 'inactive';
      else if (growth > 0.000001) status = 'growth';
      else if (growth < -0.000001) status = 'degrowth';
    }

    return {
      this: current,
      last,
      diff,
      growth,
      status,
      growth_note: last === 0 && current !== 0
        ? 'Percentage growth is not defined because last-year value is zero.'
        : ''
    };
  }

  function rawMetric(values, metric = state.metric) {
    const a = Array.isArray(values) ? values : [];
    const agg = {
      sales_qty_this: num(a[0]),
      sales_qty_last: num(a[1]),
      sales_this: num(a[2]),
      sales_last: num(a[3]),
      ff_this: num(a[4]),
      ff_last: num(a[5]),
      gpv_this: num(a[6]),
      gpv_last: num(a[7])
    };

    if (metric === 'basket') {
      const current = agg.ff_this ? agg.sales_this / agg.ff_this : 0;
      const last = agg.ff_last ? agg.sales_last / agg.ff_last : 0;
      return metricResult(current, last);
    }

    const def = METRICS[metric];
    return metricResult(agg[def.thisKey], agg[def.lastKey]);
  }

  function entityMetric(entity, metric = state.metric) {
    return entity?.metrics?.[metric] || metricResult(0, 0);
  }

  function selectedValues(key) {
    return Array.isArray(state.multi?.[key]) ? state.multi[key] : [];
  }

  function hasSelection(key) {
    return selectedValues(key).length > 0;
  }

  function anyHierarchySelection() {
    return HIERARCHY_KEYS.some(hasSelection);
  }

  function anyProductSelection() {
    return PRODUCT_KEYS.some(hasSelection);
  }

  function matchesSelection(key, value) {
    const selected = selectedValues(key);
    return !selected.length || selected.includes(String(value ?? ''));
  }

  function syncScalarFilters() {
    FILTER_KEYS.forEach(key => {
      const values = selectedValues(key);
      state[key] = values.length === 1 ? values[0] : ALL;
    });
  }

  function normalizeData() {
    const d = state.data;
    d.regions ||= [];
    d.zones ||= [];
    d.outlets ||= [];
    d.categories ||= [];
    d.sku_catalog ||= [];
    d.sku_drivers ||= { overall: { positive: [], negative: [], top_sales: [] }, regions: {}, zones: {}, outlets: {} };
    d.meta ||= {};
    d.data_quality ||= {};
    d.overall ||= { metrics: {} };

    d.regions.forEach(r => {
      r.regional_key ||= r.regional_id || r.regional_name || 'UNMAPPED-REGION';
    });

    d.zones.forEach(z => {
      z.zone_key ||= `${z.regional_key || z.regional_id || z.regional_name || 'UNMAPPED-REGION'}|${z.zonal_id || z.zonal_name || 'UNMAPPED-ZONE'}`;
    });

    d.outlets.forEach(o => {
      o.regional_key ||= o.regional_id || o.regional_name || 'UNMAPPED-REGION';
      o.zone_key ||= `${o.regional_key}|${o.zonal_id || o.zonal_name || 'UNMAPPED-ZONE'}`;
      if (o.is_active == null) o.is_active = true;
      if (o.has_performance == null) {
        o.has_performance = Object.values(o.metrics || {}).some(m => num(m.this) !== 0 || num(m.last) !== 0);
      }
    });
  }

  function resetSkuCache() {
    state.skuChunks.clear();
    state.skuHierarchyCatalog = null;
    state.skuHierarchyPromise = null;
    state.skuHierarchyError = '';
  }

  async function loadData(force = false) {
    if (state.loading) return;
    state.loading = true;
    showToast('Loading dashboard data…');

    try {
      if (force) resetSkuCache();
      const suffix = force ? `?v=${Date.now()}` : '';
      const response = await fetch(`processed/dashboard_data.json${suffix}`, { cache: force ? 'reload' : 'default' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.data = await response.json();
      normalizeData();

      if (anyHierarchySelection() && ['sku', 'detail'].includes(state.page)) {
        await ensureSkuHierarchyCatalog(force);
      }

      renderAll();
      showToast('Dashboard data loaded.');
    } catch (error) {
      if (el('content')) {
        el('content').innerHTML = `<div class="card card-pad"><h2>Dashboard data could not be loaded</h2><p class="muted">${esc(error.message)}</p></div>`;
      }
      showToast('Data load failed.');
    } finally {
      state.loading = false;
    }
  }

  function dashboardUniverse() {
    const categoryRows = (state.data?.categories || []).map(r => ({
      regional_key: r.regional_key || '',
      zone_key: r.zone_key || '',
      outlet_code: r.outlet_code || '',
      division: r.division || '',
      cat01: r.cat01 || '',
      cat03: r.cat03 || ''
    }));

    const masterRows = (state.data?.outlets || []).map(o => ({
      regional_key: o.regional_key || '',
      zone_key: o.zone_key || '',
      outlet_code: o.outlet_code || '',
      division: '', cat01: '', cat03: ''
    }));

    return categoryRows.concat(masterRows);
  }

  function rowMatchesSelections(row, ignoreKey = '') {
    return FILTER_KEYS.every(key => key === ignoreKey || matchesSelection(key, row?.[FILTER_FIELDS[key]]));
  }

  function availableValues(key) {
    const field = FILTER_FIELDS[key];
    return unique(
      dashboardUniverse()
        .filter(row => rowMatchesSelections(row, key))
        .map(row => String(row?.[field] ?? ''))
        .filter(Boolean)
    );
  }

  function optionLabel(key, value) {
    const v = String(value ?? '');
    if (key === 'regional') {
      const row = (state.data?.regions || []).find(r => String(r.regional_key) === v);
      return row ? `${row.regional_id ? `${row.regional_id} — ` : ''}${row.regional_name || v}` : v;
    }
    if (key === 'zone') {
      const row = (state.data?.zones || []).find(z => String(z.zone_key) === v);
      return row ? `${row.zonal_id ? `${row.zonal_id} — ` : ''}${row.zonal_name || v}` : v;
    }
    if (key === 'outlet') {
      const row = (state.data?.outlets || []).find(o => String(o.outlet_code) === v);
      return row ? `${row.outlet_code} — ${row.outlet_name || ''}` : v;
    }
    return v;
  }

  function selectionSummary(key) {
    const values = selectedValues(key);
    if (!values.length) return FILTER_META[key].all;
    if (values.length === 1) return optionLabel(key, values[0]);
    return `${values.length} selected`;
  }

  function reconcileSelections(preferredKey = '') {
    let changed = true;
    let guard = 0;
    const keys = preferredKey ? FILTER_KEYS.filter(key => key !== preferredKey) : FILTER_KEYS;

    while (changed && guard < 6) {
      changed = false;
      guard += 1;
      keys.forEach(key => {
        const allowed = new Set(availableValues(key));
        const kept = selectedValues(key).filter(value => allowed.has(String(value)));
        if (kept.length !== selectedValues(key).length) {
          state.multi[key] = kept;
          changed = true;
        }
      });
    }

    syncScalarFilters();
  }

  function filterOptionsHtml(key) {
    const selected = new Set(selectedValues(key));
    const values = unique([...availableValues(key), ...selected]);
    if (!values.length) return '<div class="sidebar-filter-empty">No options under the other active filters.</div>';

    return values.map(value => {
      const label = optionLabel(key, value);
      return `<label class="sidebar-filter-option" data-option-search="${esc(`${value} ${label}`.toLowerCase())}"><input type="checkbox" value="${esc(value)}" ${selected.has(String(value)) ? 'checked' : ''}><span>${esc(label)}</span></label>`;
    }).join('');
  }

  function filterControlHtml(key) {
    const meta = FILTER_META[key];
    return `<details class="sidebar-filter" data-filter-details="${key}">
      <summary><span>${esc(meta.label)}</span><strong>${esc(selectionSummary(key))}</strong></summary>
      <div class="sidebar-filter-menu">
        <input class="sidebar-filter-search" data-multi-search="${key}" type="search" placeholder="Search ${esc(meta.label)}…">
        <div class="sidebar-filter-options">${filterOptionsHtml(key)}</div>
        <div class="sidebar-filter-actions">
          <button class="sidebar-filter-link" data-multi-visible="all" type="button">Select visible</button>
          <button class="sidebar-filter-link" data-multi-visible="none" type="button">Deselect all</button>
          <span></span>
          <button class="btn btn-small btn-secondary" data-multi-clear="${key}" type="button">Clear</button>
          <button class="btn btn-small btn-primary" data-multi-apply="${key}" type="button">Apply</button>
        </div>
      </div>
    </details>`;
  }

  function renderFilterBar() {
    reconcileSelections();
    el('filterBar').innerHTML = `
      <div class="sidebar-filter-title"><span>Dashboard Filters</span><small>OR within one filter · AND between filters</small></div>
      <div class="filter-group sidebar-metric-filter"><label>Metric</label><select data-filter="metric">${Object.entries(METRICS).map(([key, def]) => `<option value="${key}" ${state.metric === key ? 'selected' : ''}>${esc(def.label)}</option>`).join('')}</select></div>
      ${filterControlHtml('regional')}
      ${filterControlHtml('zone')}
      ${filterControlHtml('outlet')}
      ${filterControlHtml('division')}
      ${filterControlHtml('cat01')}
      ${filterControlHtml('cat03')}
      ${state.viewStatus !== ALL ? `<span class="filter-chip sidebar-status-chip">Status: ${esc(statusLabel(state.viewStatus))}<button data-clear-status type="button">×</button></span>` : ''}
    `;
  }

  function renderNav() {
    el('nav').innerHTML = NAV.map(([id, icon, label]) => `<button class="nav-btn ${state.page === id ? 'active' : ''}" data-nav="${id}" type="button"><span class="nav-icon">${icon}</span>${esc(label)}</button>`).join('');
  }

  function renderAll() {
    if (!state.data) return;
    renderNav();
    renderFilterBar();
    renderPage();
    const meta = state.data.meta || {};
    el('dataStamp').innerHTML = `Generated: ${esc(dateFmt(meta.generated_at))}<br>${compactNumber(meta.total_rows_used || 0)} processed rows`;
  }

  function categoryRows() {
    return (state.data?.categories || []).filter(row => rowMatchesSelections(row));
  }

  function hierarchyFilteredOutlets() {
    let rows = (state.data?.outlets || []).filter(o =>
      matchesSelection('regional', o.regional_key) &&
      matchesSelection('zone', o.zone_key) &&
      matchesSelection('outlet', o.outlet_code)
    );

    if (anyProductSelection()) {
      const allowed = new Set(categoryRows().map(r => String(r.outlet_code || '')));
      rows = rows.filter(o => allowed.has(String(o.outlet_code || '')));
    }

    return rows;
  }

  function aggregateMetricFromRows(rows, metric = state.metric) {
    const sums = [0, 0, 0, 0, 0, 0, 0, 0];
    rows.forEach(row => (row.values || []).forEach((value, i) => { sums[i] += num(value); }));
    return rawMetric(sums, metric);
  }

  function selectedMetric() {
    if (!FILTER_KEYS.some(hasSelection)) return entityMetric(state.data.overall, state.metric);
    if ((state.data.categories || []).length) return aggregateMetricFromRows(categoryRows(), state.metric);

    const totals = hierarchyFilteredOutlets().reduce((acc, outlet) => {
      const metric = entityMetric(outlet);
      acc.this += num(metric.this);
      acc.last += num(metric.last);
      return acc;
    }, { this: 0, last: 0 });

    return metricResult(totals.this, totals.last);
  }

  function scopedCoverageCodes() {
    if ((state.data?.categories || []).length) {
      return new Set(categoryRows().map(r => String(r.outlet_code || '')).filter(Boolean));
    }
    return new Set(hierarchyFilteredOutlets().filter(o => o.has_performance).map(o => String(o.outlet_code || '')));
  }

  function aggregateHierarchy(level, metric = state.metric, applyStatus = true) {
    const cubeRows = categoryRows();
    const scopedOutlets = hierarchyFilteredOutlets();
    const dashboardFiltered = FILTER_KEYS.some(hasSelection);
    const allowedRegions = new Set(scopedOutlets.map(o => String(o.regional_key || '')));
    const allowedZones = new Set(scopedOutlets.map(o => String(o.zone_key || '')));

    let base;
    if (level === 'region') {
      base = (state.data?.regions || []).filter(r => matchesSelection('regional', r.regional_key));
      if (dashboardFiltered) base = base.filter(r => allowedRegions.has(String(r.regional_key || '')));
    } else if (level === 'zone') {
      base = (state.data?.zones || []).filter(z =>
        matchesSelection('regional', z.regional_key) && matchesSelection('zone', z.zone_key)
      );
      if (dashboardFiltered) base = base.filter(z => allowedZones.has(String(z.zone_key || '')));
    } else {
      base = scopedOutlets;
    }

    const sums = new Map();
    cubeRows.forEach(row => {
      const key = level === 'region' ? row.regional_key : level === 'zone' ? row.zone_key : row.outlet_code;
      if (!key) return;
      if (!sums.has(key)) sums.set(key, [0, 0, 0, 0, 0, 0, 0, 0]);
      (row.values || []).forEach((value, i) => { sums.get(key)[i] += num(value); });
    });

    const coverageCodes = scopedCoverageCodes();
    const counts = new Map();
    scopedOutlets.forEach(outlet => {
      const key = level === 'region' ? outlet.regional_key : level === 'zone' ? outlet.zone_key : outlet.outlet_code;
      if (!key) return;
      if (!counts.has(key)) counts.set(key, { outlet_count: 0, active_outlet_count: 0, performance_outlet_count: 0 });
      const c = counts.get(key);
      c.outlet_count += 1;
      if (outlet.is_active !== false) c.active_outlet_count += 1;
      if (coverageCodes.has(String(outlet.outlet_code || ''))) c.performance_outlet_count += 1;
    });

    const rows = base.map(entity => {
      const key = level === 'region' ? entity.regional_key : level === 'zone' ? entity.zone_key : entity.outlet_code;
      const metricValue = (state.data?.categories || []).length
        ? rawMetric(sums.get(key) || [0, 0, 0, 0, 0, 0, 0, 0], metric)
        : entityMetric(entity, metric);
      const c = counts.get(key) || {
        outlet_count: level === 'outlet' ? 1 : 0,
        active_outlet_count: level === 'outlet' && entity.is_active !== false ? 1 : 0,
        performance_outlet_count: level === 'outlet' && entity.has_performance ? 1 : 0
      };
      return { ...entity, ...c, _metric: metricValue };
    });

    if (!applyStatus || state.viewStatus === ALL) return rows;
    return rows.filter(row => state.viewStatus === 'degrowth'
      ? ['degrowth', 'inactive'].includes(row._metric.status)
      : row._metric.status === state.viewStatus
    );
  }

  function performanceCounts() {
    const rows = aggregateHierarchy('outlet', state.metric, false);
    const counts = { growth: 0, degrowth: 0, flat: 0, new: 0, inactive: 0, active: 0, total: rows.length, withData: 0 };
    rows.forEach(row => {
      const m = row._metric;
      counts[m.status] = (counts[m.status] || 0) + 1;
      counts.active += num(row.active_outlet_count);
      counts.withData += num(row.performance_outlet_count);
    });
    return counts;
  }

  function categorySummaryRows() {
    const map = new Map();
    categoryRows().forEach(row => {
      const key = `${row.division}|${row.cat01}|${row.cat03}`;
      if (!map.has(key)) {
        map.set(key, { division: row.division, cat01: row.cat01, cat03: row.cat03, values: [0, 0, 0, 0, 0, 0, 0, 0] });
      }
      (row.values || []).forEach((value, i) => { map.get(key).values[i] += num(value); });
    });
    return [...map.values()].map(row => ({ ...row, _metric: rawMetric(row.values) }));
  }

  function addArrays(target, source) {
    const out = target || [0, 0, 0, 0, 0, 0, 0, 0];
    (source || []).forEach((value, i) => { out[i] += num(value); });
    return out;
  }

  async function fetchSkuChunk(bucket, force = false) {
    if (!force && state.skuChunks.has(bucket)) return state.skuChunks.get(bucket);
    const suffix = force ? `?v=${Date.now()}` : '';
    const response = await fetch(`processed/sku_chunks/${bucket}.json${suffix}`, { cache: force ? 'reload' : 'default' });
    if (!response.ok) throw new Error(`SKU chunk ${bucket} failed with HTTP ${response.status}`);
    const json = await response.json();
    state.skuChunks.set(bucket, json);
    return json;
  }

  async function ensureSkuHierarchyCatalog(force = false) {
    if (!anyHierarchySelection()) return;
    if (!force && state.skuHierarchyCatalog) return;
    if (!force && state.skuHierarchyPromise) return state.skuHierarchyPromise;

    state.skuHierarchyError = '';
    const count = Math.max(1, num(state.data?.meta?.sku_chunk_count) || SKU_CHUNK_FALLBACK_COUNT);
    const buckets = Array.from({ length: count }, (_, i) => String(i).padStart(2, '0'));

    state.skuHierarchyPromise = (async () => {
      showToast('Loading hierarchy-level SKU data…');
      const merged = [];
      const batchSize = 8;

      for (let i = 0; i < buckets.length; i += batchSize) {
        const batch = buckets.slice(i, i + batchSize);
        const chunks = await Promise.all(batch.map(bucket => fetchSkuChunk(bucket, force)));
        chunks.forEach(chunk => {
          Object.values(chunk?.skus || {}).forEach(item => merged.push(item));
        });
      }

      state.skuHierarchyCatalog = merged;
      state.skuHierarchyPromise = null;
      showToast(`Loaded ${compactNumber(merged.length)} SKU hierarchy records.`);
    })().catch(error => {
      state.skuHierarchyError = error.message || String(error);
      state.skuHierarchyPromise = null;
      state.skuHierarchyCatalog = [];
      showToast('Hierarchy SKU data could not be loaded.');
      throw error;
    });

    return state.skuHierarchyPromise;
  }

  function hierarchyValuesForSku(item) {
    if (!anyHierarchySelection()) return item.overall || item.values || [];

    const selectedOutlets = selectedValues('outlet');
    const selectedZones = selectedValues('zone');
    const selectedRegions = selectedValues('regional');
    const sums = [0, 0, 0, 0, 0, 0, 0, 0];

    if (selectedOutlets.length) {
      selectedOutlets.forEach(code => addArrays(sums, item.outlets?.[code]));
      return sums;
    }
    if (selectedZones.length) {
      selectedZones.forEach(key => addArrays(sums, item.zones?.[key]));
      return sums;
    }
    if (selectedRegions.length) {
      selectedRegions.forEach(key => addArrays(sums, item.regions?.[key]));
      return sums;
    }

    return item.overall || [];
  }

  function skuRows() {
    if (!anyHierarchySelection()) {
      return (state.data?.sku_catalog || [])
        .filter(row =>
          matchesSelection('division', row.division) &&
          matchesSelection('cat01', row.cat01) &&
          matchesSelection('cat03', row.cat03)
        )
        .map(row => ({ ...row, _metric: rawMetric(row.values) }));
    }

    const source = state.skuHierarchyCatalog || [];
    return source
      .filter(item =>
        matchesSelection('division', item.division) &&
        matchesSelection('cat01', item.cat01) &&
        matchesSelection('cat03', item.cat03)
      )
      .map(item => {
        const values = hierarchyValuesForSku(item);
        return {
          sku: item.sku,
          sku_name: item.sku_name,
          division: item.division,
          cat01: item.cat01,
          cat03: item.cat03,
          values,
          _metric: rawMetric(values)
        };
      })
      .filter(row => row.values.some(value => Math.abs(num(value)) > 1e-9));
  }

  function currentDriverSet() {
    if (FILTER_KEYS.some(hasSelection)) {
      const rows = skuRows().map(row => ({ ...row, metrics: { [state.metric]: row._metric } }));
      return {
        positive: rows.filter(r => r._metric.diff > 0).sort((a, b) => b._metric.diff - a._metric.diff).slice(0, 50),
        negative: rows.filter(r => r._metric.diff < 0).sort((a, b) => a._metric.diff - b._metric.diff).slice(0, 50),
        top_sales: rows.slice().sort((a, b) => b._metric.this - a._metric.this).slice(0, 50)
      };
    }

    return state.data?.sku_drivers?.overall || { positive: [], negative: [], top_sales: [] };
  }

  function kpiCard(label, value, sub, cls = '') {
    return `<article class="card kpi"><span class="kpi-label">${esc(label)}</span><strong class="kpi-value ${cls}">${value}</strong><div class="kpi-sub">${sub}</div></article>`;
  }

  function summaryTile(label, value, foot = '') {
    return `<div class="summary-tile"><span class="muted">${esc(label)}</span><strong>${compactNumber(value)}</strong><div style="margin-top:7px">${foot}</div></div>`;
  }

  function coveragePanel() {
    const rows = aggregateHierarchy('outlet', state.metric, false);
    const active = rows.reduce((sum, row) => sum + num(row.active_outlet_count), 0);
    const covered = rows.reduce((sum, row) => sum + num(row.performance_outlet_count), 0);
    const regionCount = new Set(rows.map(r => String(r.regional_key || '')).filter(Boolean)).size;
    const zoneCount = new Set(rows.map(r => String(r.zone_key || '')).filter(Boolean)).size;
    return `<div class="summary-grid">${[
      ['Master outlets', rows.length],
      ['Active outlets', active],
      ['Performance outlets', covered],
      ['Master without performance', Math.max(0, rows.length - covered)],
      ['Regional Heads', regionCount],
      ['Zones', zoneCount]
    ].map(([label, value]) => summaryTile(label, value)).join('')}</div>`;
  }

  function barPanel(title, rows, negative, status) {
    const max = Math.max(1, ...rows.map(r => Math.abs(r._metric.diff)));
    return `<section class="card"><div class="card-head"><div><h2>${esc(title)}</h2><p>${esc(metricDef().label)} absolute difference.</p></div><button class="btn btn-small btn-secondary" data-action="view-status" data-status="${status}" type="button">View all</button></div>
      ${rows.length ? `<div class="chart-list">${rows.map(row => `<div class="bar-row"><span class="bar-label" title="${esc(row.outlet_name)}">${esc(row.outlet_code)} · ${esc(row.outlet_name)}</span><span class="bar-track"><span class="bar-fill ${negative ? 'negative' : ''}" style="width:${Math.max(2, Math.abs(row._metric.diff) / max * 100)}%"></span></span><span class="bar-value ${row._metric.diff < 0 ? 'bad' : 'good'}">${esc(formatMetric(row._metric.diff))}</span></div>`).join('')}</div>` : '<div class="empty">No matching outlets.</div>'}
    </section>`;
  }

  function performanceColumns(level) {
    const cols = [];
    if (level === 'region') cols.push({ key: 'regional_id', label: 'Regional ID' }, { key: 'regional_name', label: 'Regional Head' });
    if (level === 'zone') cols.push({ key: 'regional_name', label: 'Regional Head' }, { key: 'zonal_id', label: 'Zonal ID' }, { key: 'zonal_name', label: 'Zonal Name' });
    if (level === 'outlet') cols.push(
      { key: 'regional_name', label: 'Regional Head' },
      { key: 'zonal_name', label: 'Zonal Name' },
      { key: 'outlet_code', label: 'Outlet Code' },
      { key: 'outlet_name', label: 'Outlet Name', wrap: true }
    );
    cols.push(
      { key: 'active_outlet_count', label: 'Active Outlets', type: 'number', value: r => r.active_outlet_count ?? 0 },
      { key: 'performance_outlet_count', label: 'Sales-covered', type: 'number', value: r => r.performance_outlet_count ?? 0 },
      { key: 'outlet_count', label: 'Total Outlets', type: 'number', value: r => r.outlet_count ?? 0 },
      { key: 'metric_this', label: `${metricDef().label} This`, type: 'number', value: r => r._metric.this, render: r => formatMetric(r._metric.this) },
      { key: 'metric_last', label: `${metricDef().label} Last`, type: 'number', value: r => r._metric.last, render: r => formatMetric(r._metric.last) },
      { key: 'metric_diff', label: 'Difference', type: 'number', value: r => r._metric.diff, render: r => `<span class="${r._metric.diff < 0 ? 'bad' : r._metric.diff > 0 ? 'good' : ''}">${esc(formatMetric(r._metric.diff))}</span>` },
      { key: 'metric_growth', label: 'Growth %', type: 'number', value: r => r._metric.growth, render: r => r._metric.last === 0 && r._metric.this !== 0 ? '—' : pct(r._metric.growth) },
      { key: 'metric_status', label: 'Status', value: r => statusLabel(r._metric.status), render: r => statusBadge(r._metric.status) }
    );
    return cols;
  }

  function productColumns(kind) {
    const idCols = kind === 'sku'
      ? [{ key: 'sku', label: 'SKU' }, { key: 'sku_name', label: 'SKU Name', wrap: true }]
      : [];
    return idCols.concat([
      { key: 'division', label: 'Division' },
      { key: 'cat01', label: 'Cat 01' },
      { key: 'cat03', label: 'Cat 03' },
      { key: 'this', label: `${metricDef().label} This`, type: 'number', value: r => r._metric.this, render: r => formatMetric(r._metric.this) },
      { key: 'last', label: `${metricDef().label} Last`, type: 'number', value: r => r._metric.last, render: r => formatMetric(r._metric.last) },
      { key: 'diff', label: 'Difference', type: 'number', value: r => r._metric.diff, render: r => `<span class="${r._metric.diff < 0 ? 'bad' : r._metric.diff > 0 ? 'good' : ''}">${esc(formatMetric(r._metric.diff))}</span>` },
      { key: 'growth', label: 'Growth %', type: 'number', value: r => r._metric.growth, render: r => r._metric.last === 0 && r._metric.this !== 0 ? '—' : pct(r._metric.growth) },
      { key: 'status', label: 'Status', value: r => statusLabel(r._metric.status), render: r => statusBadge(r._metric.status) }
    ]);
  }

  function renderExecutive() {
    const m = selectedMetric();
    const c = performanceCounts();
    const allRows = aggregateHierarchy('outlet', state.metric, false);
    const growing = allRows.filter(r => r._metric.status === 'growth').sort((a, b) => b._metric.diff - a._metric.diff).slice(0, 10);
    const falling = allRows.filter(r => ['degrowth', 'inactive'].includes(r._metric.status)).sort((a, b) => a._metric.diff - b._metric.diff).slice(0, 10);
    const currentCls = ['degrowth', 'inactive'].includes(m.status) ? 'bad' : ['growth', 'new'].includes(m.status) ? 'good' : '';

    return `
      <div class="grid kpi-grid">
        ${kpiCard(`${metricDef().label} This`, formatMetric(m.this), `Current selected scope · ${statusBadge(m.status)}`, currentCls)}
        ${kpiCard(`${metricDef().label} Last`, formatMetric(m.last), m.last === 0 ? 'No last-year base in selected scope' : 'Comparable last-year value')}
        ${kpiCard('Difference', formatMetric(m.diff), 'Absolute change from last year', m.diff < 0 ? 'bad' : m.diff > 0 ? 'good' : '')}
        ${kpiCard('Growth %', pct(m.growth), m.last === 0 && m.this !== 0 ? 'Not calculated because last-year value is zero' : 'Difference ÷ absolute last-year value', m.growth < 0 ? 'bad' : m.growth > 0 ? 'good' : '')}
      </div>
      <div class="grid two-col">
        <section class="card"><div class="card-head"><div><h2>Performance Summary</h2><p>Outlet counts under the active hierarchy and category scope.</p></div></div><div class="summary-grid">
          ${summaryTile('Active Outlets', c.active)}
          ${summaryTile('Sales-covered Outlets', c.withData)}
          ${summaryTile('Total Master Outlets', c.total)}
          ${summaryTile('Growing', c.growth, '<button class="btn btn-small btn-secondary" data-action="view-status" data-status="growth">View all</button>')}
          ${summaryTile('De-growing', c.degrowth + c.inactive, '<button class="btn btn-small btn-secondary" data-action="view-status" data-status="degrowth">View all</button>')}
          ${summaryTile('New (LY=0)', c.new, '<button class="btn btn-small btn-secondary" data-action="view-status" data-status="new">View all</button>')}
        </div></section>
        <section class="card"><div class="card-head"><div><h2>Network Coverage</h2><p>Master hierarchy versus performance coverage.</p></div></div>${coveragePanel()}</section>
      </div>
      <div class="grid equal-col" style="margin-top:16px">${barPanel('Top Growing Outlets', growing, false, 'growth')}${barPanel('Largest De-growth Outlets', falling, true, 'degrowth')}</div>`;
  }

  function renderLeader() {
    return tableCard('regional-performance', 'Regional Head Performance', 'Active sidebar filters are applied.', performanceColumns('region'), aggregateHierarchy('region'), { sortKey: 'metric_diff', sortDir: 'desc' });
  }

  function renderZonal() {
    return tableCard('zonal-performance', 'Zonal Performance', 'Active sidebar filters are applied.', performanceColumns('zone'), aggregateHierarchy('zone'), { sortKey: 'metric_diff', sortDir: 'desc' });
  }

  function renderOutlet() {
    const rows = aggregateHierarchy('outlet');
    const cols = performanceColumns('outlet').concat([
      { key: 'format', label: 'Format' },
      { key: 'ownership_status', label: 'Ownership' },
      { key: 'location_type', label: 'Location Type' },
      { key: 'sft', label: 'SFT', type: 'number' },
      { key: 'master_status', label: 'Master Status', value: r => r.is_active === false ? 'Inactive' : 'Active' }
    ]);
    return tableCard('outlet-performance', 'Outlet Performance', 'Search, sort, filter and export the selected outlet scope.', cols, rows, { sortKey: 'metric_diff', sortDir: 'desc' });
  }

  function skuLoadNotice() {
    if (!anyHierarchySelection()) return '';
    if (state.skuHierarchyError) return `<div class="notice warning" style="margin-bottom:16px"><strong>SKU hierarchy data failed to load.</strong> ${esc(state.skuHierarchyError)}</div>`;
    return '';
  }

  function renderSku() {
    const cats = categorySummaryRows();
    const skus = skuRows();
    const drivers = currentDriverSet();
    const growth = (drivers.positive || []).map(r => ({ ...r, _metric: r._metric || entityMetric(r) }));
    const decline = (drivers.negative || []).map(r => ({ ...r, _metric: r._metric || entityMetric(r) }));

    return `${skuLoadNotice()}
      <div class="grid equal-col">
        ${tableCard('sku-growth-drivers', 'SKU Growth Drivers', 'Largest positive contribution inside the active filters.', productColumns('sku'), growth, { sortKey: 'diff', sortDir: 'desc' })}
        ${tableCard('sku-degrowth-drivers', 'SKU De-growth Drivers', 'Largest negative contribution inside the active filters.', productColumns('sku'), decline, { sortKey: 'diff', sortDir: 'asc' })}
      </div>
      <div style="height:16px"></div>
      ${tableCard('category-analysis', 'Category Analysis', 'Division / Cat 01 / Cat 03 performance under the active hierarchy filters.', productColumns('category'), cats, { sortKey: 'diff', sortDir: 'desc' })}
      <div style="height:16px"></div>
      ${tableCard('sku-analysis', 'All SKU Analysis', 'Fully connected to Regional Head, Zone, Outlet, Division, Cat 01 and Cat 03 filters.', productColumns('sku'), skus, { sortKey: 'this', sortDir: 'desc' })}`;
  }

  function renderDetail() {
    const outletCols = performanceColumns('outlet').concat([
      { key: 'format', label: 'Format' },
      { key: 'ownership_status', label: 'Ownership' },
      { key: 'location_type', label: 'Location Type' }
    ]);
    const categoryDetail = categoryRows().map(r => ({ ...r, _metric: rawMetric(r.values) }));

    return `${skuLoadNotice()}
      ${tableCard('detail-outlets', 'Detailed Outlet Data', 'Every matching outlet from the master hierarchy.', outletCols, aggregateHierarchy('outlet'), { sortKey: 'outlet_code', sortDir: 'asc' })}
      <div style="height:16px"></div>
      ${tableCard('detail-category', 'Detailed Category Data', 'Outlet-by-category cube for the active filters.', [
        { key: 'outlet_code', label: 'Outlet Code' },
        { key: 'division', label: 'Division' },
        { key: 'cat01', label: 'Cat 01' },
        { key: 'cat03', label: 'Cat 03' },
        ...productColumns('category').slice(3)
      ], categoryDetail, { sortKey: 'diff', sortDir: 'desc' })}
      <div style="height:16px"></div>
      ${tableCard('detail-sku', 'Detailed SKU Catalog', 'Fully connected to all active sidebar filters.', productColumns('sku'), skuRows(), { sortKey: 'sku', sortDir: 'asc' })}`;
  }

  function renderQuality() {
    const m = state.data.meta || {};
    const q = state.data.data_quality || {};
    const files = m.performance_files || [];
    const fileCols = [
      { key: 'file', label: 'Source File', wrap: true },
      { key: 'sheet_name', label: 'Sheet' },
      { key: 'header_row', label: 'Header Row', type: 'number' },
      { key: 'rows_read', label: 'Rows Read', type: 'number' },
      { key: 'rows_used', label: 'Rows Used', type: 'number' },
      { key: 'outlets', label: 'Outlets', type: 'number' },
      { key: 'missing_headers', label: 'Missing Headers', value: r => (r.missing_headers || []).join(', '), wrap: true }
    ];
    const warnings = (q.warnings || []).map((x, i) => ({
      id: i + 1,
      type: x.type || 'warning',
      file: x.file || '',
      details: Array.isArray(x.details) ? x.details.join(', ') : JSON.stringify(x.details || '')
    }));

    return `<div class="grid kpi-grid">
      ${kpiCard('Rows Read', compactNumber(m.total_rows_read || 0), 'Across all performance files')}
      ${kpiCard('Rows Used', compactNumber(m.total_rows_used || 0), 'After validation and duplicate removal')}
      ${kpiCard('Duplicate Records', compactNumber(m.duplicate_records || 0), 'Duplicate Outlet Code + SKU excluded')}
      ${kpiCard('Invalid Rows', compactNumber(m.invalid_rows || 0), 'Missing outlet code or SKU')}
    </div>
    ${tableCard('source-files', 'Source Processing', 'Workbook and selected worksheet details.', fileCols, files, { sortKey: 'file', sortDir: 'asc' })}
    <div style="height:16px"></div>
    ${tableCard('quality-warnings', 'Warnings', 'Source validation warnings.', [
      { key: 'id', label: '#', type: 'number' }, { key: 'type', label: 'Type' }, { key: 'file', label: 'File', wrap: true }, { key: 'details', label: 'Details', wrap: true }
    ], warnings, { sortKey: 'id', sortDir: 'asc' })}`;
  }

  function renderReports() {
    const reports = [
      ['regional', 'Regional Head Performance', 'Filtered Regional Head performance.'],
      ['zonal', 'Zonal Performance', 'Filtered zonal performance.'],
      ['outlet', 'Outlet Performance', 'Filtered outlet performance.'],
      ['category', 'Category Analysis', 'Filtered category analysis.'],
      ['sku', 'SKU Analysis', 'Filtered SKU catalog including hierarchy filters.'],
      ['drivers-growth', 'SKU Growth Drivers', 'Filtered positive SKU contribution.'],
      ['drivers-degrowth', 'SKU De-growth Drivers', 'Filtered negative SKU contribution.'],
      ['quality', 'Data Quality JSON', 'Data quality findings and build metadata.'],
      ['snapshot', 'Complete Dashboard JSON', 'Processed dashboard snapshot.']
    ];
    return `<section class="card"><div class="card-head"><div><h2>Reports & Export</h2><p>Downloads are generated in the browser.</p></div></div><div class="card-pad"><div class="report-grid">${reports.map(([id, title, desc]) => `<article class="report-card"><h3>${esc(title)}</h3><p>${esc(desc)}</p><button class="btn btn-primary" data-report="${id}" type="button">Download</button></article>`).join('')}</div></div></section>`;
  }

  function renderPage() {
    runtimeTables.clear();
    const meta = PAGE_META[state.page] || PAGE_META.executive;
    el('pageTitle').textContent = meta[0];
    el('pageSubtitle').textContent = meta[1];
    const renderers = {
      executive: renderExecutive,
      leader: renderLeader,
      zonal: renderZonal,
      outlet: renderOutlet,
      sku: renderSku,
      detail: renderDetail,
      quality: renderQuality,
      reports: renderReports
    };
    el('content').innerHTML = (renderers[state.page] || renderExecutive)();
    attachDragHandlers();
  }

  function tableCard(id, title, subtitle, columns, rows, defaults = {}) {
    return `<section class="card smart-table-card"><div class="card-head"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div></div>${smartTable(id, columns, rows, defaults)}</section>`;
  }

  function tableCellValue(col, row) {
    return col.value ? col.value(row) : row?.[col.key];
  }

  function smartTable(id, columns, rows, defaults = {}) {
    if (!state.tableState[id]) {
      state.tableState[id] = {
        search: '',
        sortKey: defaults.sortKey || columns[0]?.key,
        sortDir: defaults.sortDir || 'asc',
        filters: {},
        order: columns.map(c => c.key),
        page: 1,
        pageSize: PAGE_SIZE
      };
    }

    const ts = state.tableState[id];
    const colMap = new Map(columns.map(c => [c.key, c]));
    ts.order = ts.order.filter(key => colMap.has(key)).concat(columns.map(c => c.key).filter(key => !ts.order.includes(key)));
    const ordered = ts.order.map(key => colMap.get(key));
    runtimeTables.set(id, { columns: ordered, rows });

    const processed = processRows(id, ordered, rows);
    const pages = Math.max(1, Math.ceil(processed.length / ts.pageSize));
    ts.page = Math.min(Math.max(1, ts.page), pages);
    const pageRows = processed.slice((ts.page - 1) * ts.pageSize, ts.page * ts.pageSize);

    return `<div class="smart-table" data-table="${id}">
      <div class="table-toolbar">
        <input type="search" data-table-search="${id}" value="${esc(ts.search)}" placeholder="Search this table…">
        <label class="muted">Rows <select data-table-size="${id}">${[10, 25, 50, 100, 250].map(n => `<option ${ts.pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <button class="btn btn-small btn-secondary" data-table-reset="${id}" type="button">Reset table</button>
        <button class="btn btn-small btn-primary" data-table-export="${id}" type="button">Export CSV</button>
        <span class="table-count">${compactNumber(processed.length)} of ${compactNumber(rows.length)} rows</span>
      </div>
      <div class="table-wrap"><table><thead><tr>${ordered.map(col => {
        const active = ts.filters[col.key]?.length;
        const sort = ts.sortKey === col.key ? `<span class="sort-mark">${ts.sortDir === 'asc' ? '▲' : '▼'}</span>` : '';
        return `<th draggable="true" data-drag-table="${id}" data-col="${esc(col.key)}"><div class="th-inner"><button class="th-sort" data-table-sort="${id}" data-col="${esc(col.key)}" type="button">${esc(col.label)} ${sort}</button><button class="th-filter ${active ? 'active' : ''}" data-table-filter="${id}" data-col="${esc(col.key)}" type="button" title="Filter ${esc(col.label)}">▼</button></div></th>`;
      }).join('')}</tr></thead><tbody>${pageRows.length ? pageRows.map(row => `<tr>${ordered.map(col => {
        const raw = tableCellValue(col, row);
        const rendered = col.render ? col.render(row) : esc(raw ?? '');
        return `<td class="${col.type === 'number' ? 'cell-number' : ''} ${col.wrap ? 'cell-wrap' : ''}">${rendered}</td>`;
      }).join('')}</tr>`).join('') : `<tr><td colspan="${ordered.length}"><div class="empty">No rows match the current filters.</div></td></tr>`}</tbody></table></div>
      <div class="table-pagination"><button class="page-btn" data-table-page="${id}" data-page="${ts.page - 1}" ${ts.page <= 1 ? 'disabled' : ''}>‹</button>${pageButtons(ts.page, pages).map(p => p === '…' ? '<span>…</span>' : `<button class="page-btn ${p === ts.page ? 'active' : ''}" data-table-page="${id}" data-page="${p}">${p}</button>`).join('')}<button class="page-btn" data-table-page="${id}" data-page="${ts.page + 1}" ${ts.page >= pages ? 'disabled' : ''}>›</button></div>
    </div>`;
  }

  function processRows(id, columns, rows) {
    const ts = state.tableState[id];
    let out = [...rows];
    const q = text(ts.search).toLowerCase();
    if (q) out = out.filter(row => columns.some(col => text(tableCellValue(col, row)).toLowerCase().includes(q)));

    Object.entries(ts.filters).forEach(([key, values]) => {
      if (!values?.length) return;
      const col = columns.find(c => c.key === key);
      if (!col) return;
      const set = new Set(values.map(String));
      out = out.filter(row => set.has(String(tableCellValue(col, row) ?? '')));
    });

    const sortCol = columns.find(c => c.key === ts.sortKey);
    if (sortCol) {
      out.sort((a, b) => compare(tableCellValue(sortCol, a), tableCellValue(sortCol, b), sortCol.type) * (ts.sortDir === 'desc' ? -1 : 1));
    }
    return out;
  }

  function compare(a, b, type) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (type === 'number' || (Number.isFinite(Number(a)) && Number.isFinite(Number(b)))) return num(a) - num(b);
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  function pageButtons(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = [1];
    if (current > 4) pages.push('…');
    for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i += 1) pages.push(i);
    if (current < total - 3) pages.push('…');
    pages.push(total);
    return pages;
  }

  function rerenderContent() {
    renderPage();
  }

  function openColumnFilter(tableId, colKey, button) {
    const rt = runtimeTables.get(tableId);
    const ts = state.tableState[tableId];
    if (!rt || !ts) return;
    const col = rt.columns.find(c => c.key === colKey);
    if (!col) return;

    const values = unique(rt.rows.map(row => String(tableCellValue(col, row) ?? '')));
    const selected = new Set((ts.filters[colKey] || []).map(String));
    openFilter = { tableId, colKey, values, selected, col };

    const pop = el('filterPopover');
    pop.innerHTML = `<div class="filter-popover-head"><strong>${esc(col.label)}</strong><input id="filterValueSearch" type="search" placeholder="Search values…"><div class="filter-sort-actions"><button class="btn btn-small btn-secondary" data-pop-sort="asc">Sort smallest / A–Z</button><button class="btn btn-small btn-secondary" data-pop-sort="desc">Sort largest / Z–A</button></div></div><div id="filterValueList" class="filter-values">${filterValueHtml(values, selected)}</div><div class="filter-popover-foot"><button class="btn btn-small btn-secondary" data-pop-clear type="button">Clear</button><button class="btn btn-small btn-primary" data-pop-apply type="button">Apply</button></div>`;

    const rect = button.getBoundingClientRect();
    pop.style.left = `${Math.min(window.innerWidth - 342, Math.max(12, rect.left - 270))}px`;
    pop.style.top = `${Math.min(window.innerHeight - 500, rect.bottom + 5)}px`;
    pop.hidden = false;
  }

  function filterValueHtml(values, selected, q = '') {
    const query = q.toLowerCase();
    return values.filter(v => v.toLowerCase().includes(query)).map(v => `<label class="filter-option"><input type="checkbox" data-pop-value="${esc(v)}" ${selected.has(v) ? 'checked' : ''}><span>${esc(v || '(blank)')}</span></label>`).join('') || '<div class="empty">No values found.</div>';
  }

  function closePopover() {
    el('filterPopover').hidden = true;
    openFilter = null;
  }

  function attachDragHandlers() {
    document.querySelectorAll('th[draggable="true"]').forEach(th => {
      th.addEventListener('dragstart', event => {
        th.classList.add('dragging');
        event.dataTransfer.setData('text/plain', `${th.dataset.dragTable}|${th.dataset.col}`);
      });
      th.addEventListener('dragend', () => th.classList.remove('dragging'));
      th.addEventListener('dragover', event => event.preventDefault());
      th.addEventListener('drop', event => {
        event.preventDefault();
        const [tableId, source] = event.dataTransfer.getData('text/plain').split('|');
        if (tableId !== th.dataset.dragTable) return;
        const target = th.dataset.col;
        const order = state.tableState[tableId].order;
        const sourceIndex = order.indexOf(source);
        const targetIndex = order.indexOf(target);
        if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
        order.splice(targetIndex, 0, order.splice(sourceIndex, 1)[0]);
        rerenderContent();
      });
    });
  }

  function csvEscape(value) {
    const s = String(value ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function downloadBlob(name, content, type = 'text/csv;charset=utf-8') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
    showToast(`Downloaded ${name}`);
  }

  function exportTable(id) {
    const rt = runtimeTables.get(id);
    if (!rt) { showToast('No active table to export.'); return; }
    const rows = processRows(id, rt.columns, rt.rows);
    const csv = [
      rt.columns.map(c => csvEscape(c.label)).join(','),
      ...rows.map(row => rt.columns.map(c => csvEscape(tableCellValue(c, row))).join(','))
    ].join('\n');
    downloadBlob(`${id}-${new Date().toISOString().slice(0, 10)}.csv`, '\ufeff' + csv);
  }

  function flattenPerformance(rows) {
    return rows.map(row => {
      const m = row._metric || entityMetric(row);
      return { ...row, metric: metricDef().label, metric_this: m.this, metric_last: m.last, difference: m.diff, growth_pct: m.growth, status: statusLabel(m.status) };
    });
  }

  function rowsToCsv(name, rows) {
    if (!rows.length) { showToast('No rows available for this report.'); return; }
    const keys = [...new Set(rows.flatMap(Object.keys))].filter(key => !['metrics', 'values', '_metric'].includes(key));
    const csv = [
      keys.map(csvEscape).join(','),
      ...rows.map(row => keys.map(key => csvEscape(typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key])).join(','))
    ].join('\n');
    downloadBlob(`${name}-${new Date().toISOString().slice(0, 10)}.csv`, '\ufeff' + csv);
  }

  async function downloadReport(id) {
    if (['sku', 'drivers-growth', 'drivers-degrowth'].includes(id) && anyHierarchySelection()) {
      try { await ensureSkuHierarchyCatalog(); } catch (_) { return; }
    }
    if (id === 'regional') return rowsToCsv('regional-performance', flattenPerformance(aggregateHierarchy('region')));
    if (id === 'zonal') return rowsToCsv('zonal-performance', flattenPerformance(aggregateHierarchy('zone')));
    if (id === 'outlet') return rowsToCsv('outlet-performance', flattenPerformance(aggregateHierarchy('outlet')));
    if (id === 'category') return rowsToCsv('category-analysis', categorySummaryRows().map(r => ({ ...r, metric: metricDef().label, ...r._metric })));
    if (id === 'sku') return rowsToCsv('sku-analysis', skuRows().map(r => ({ ...r, metric: metricDef().label, ...r._metric })));
    if (id === 'drivers-growth' || id === 'drivers-degrowth') {
      const drivers = currentDriverSet();
      const rows = id === 'drivers-growth' ? drivers.positive : drivers.negative;
      return rowsToCsv(id, rows.map(r => ({ ...r, ...(r._metric || entityMetric(r)) })));
    }
    if (id === 'quality') return downloadBlob('dashboard-data-quality.json', JSON.stringify({ meta: state.data.meta, data_quality: state.data.data_quality }, null, 2), 'application/json');
    if (id === 'snapshot') return downloadBlob('dashboard-data-snapshot.json', JSON.stringify(state.data, null, 2), 'application/json');
  }

  function exportCurrent() {
    const first = [...runtimeTables.keys()][0];
    if (first) exportTable(first);
    else showToast('This page has no exportable table.');
  }

  function showToast(message) {
    const toast = el('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 2600);
  }

  function clearGlobalFilters() {
    FILTER_KEYS.forEach(key => { state.multi[key] = []; });
    Object.assign(state, { regional: ALL, zone: ALL, outlet: ALL, division: ALL, cat01: ALL, cat03: ALL, viewStatus: ALL });
    state.tableState = {};
    renderAll();
  }

  async function prepareSkuPageIfNeeded() {
    if (!anyHierarchySelection() || !['sku', 'detail'].includes(state.page)) return;
    if (state.skuHierarchyCatalog) return;
    el('content').innerHTML = '<div class="loading-card"><div class="spinner" aria-hidden="true"></div><p>Loading hierarchy-level SKU data…</p></div>';
    try {
      await ensureSkuHierarchyCatalog();
    } catch (_) {
      // The render functions will show the stored error message.
    }
  }

  document.addEventListener('click', async event => {
    const apply = event.target.closest('[data-multi-apply]');
    if (apply) {
      event.preventDefault();
      event.stopPropagation();
      const key = apply.dataset.multiApply;
      const details = apply.closest('[data-filter-details]');
      state.multi[key] = unique([...details.querySelectorAll('.sidebar-filter-option input:checked')].map(input => input.value));
      reconcileSelections(key);
      state.tableState = {};
      await prepareSkuPageIfNeeded();
      renderAll();
      return;
    }

    const clear = event.target.closest('[data-multi-clear]');
    if (clear) {
      event.preventDefault();
      event.stopPropagation();
      const key = clear.dataset.multiClear;
      state.multi[key] = [];
      reconcileSelections(key);
      state.tableState = {};
      await prepareSkuPageIfNeeded();
      renderAll();
      return;
    }

    const visible = event.target.closest('[data-multi-visible]');
    if (visible) {
      event.preventDefault();
      event.stopPropagation();
      const details = visible.closest('[data-filter-details]');
      details.querySelectorAll('.sidebar-filter-option:not([hidden]) input').forEach(input => {
        input.checked = visible.dataset.multiVisible === 'all';
      });
      return;
    }

    const nav = event.target.closest('[data-nav]');
    if (nav) {
      state.page = nav.dataset.nav;
      state.viewStatus = ALL;
      await prepareSkuPageIfNeeded();
      renderAll();
      return;
    }

    const action = event.target.closest('[data-action="view-status"]');
    if (action) {
      state.viewStatus = action.dataset.status;
      state.page = 'outlet';
      renderAll();
      return;
    }

    if (event.target.closest('[data-clear-status]')) {
      state.viewStatus = ALL;
      renderAll();
      return;
    }

    const sort = event.target.closest('[data-table-sort]');
    if (sort) {
      const ts = state.tableState[sort.dataset.tableSort];
      const key = sort.dataset.col;
      ts.sortDir = ts.sortKey === key && ts.sortDir === 'asc' ? 'desc' : 'asc';
      ts.sortKey = key;
      ts.page = 1;
      rerenderContent();
      return;
    }

    const filter = event.target.closest('[data-table-filter]');
    if (filter) {
      openColumnFilter(filter.dataset.tableFilter, filter.dataset.col, filter);
      return;
    }

    const page = event.target.closest('[data-table-page]');
    if (page && !page.disabled) {
      state.tableState[page.dataset.tablePage].page = num(page.dataset.page);
      rerenderContent();
      return;
    }

    const reset = event.target.closest('[data-table-reset]');
    if (reset) {
      delete state.tableState[reset.dataset.tableReset];
      rerenderContent();
      return;
    }

    const exportBtn = event.target.closest('[data-table-export]');
    if (exportBtn) {
      exportTable(exportBtn.dataset.tableExport);
      return;
    }

    const report = event.target.closest('[data-report]');
    if (report) {
      await downloadReport(report.dataset.report);
      return;
    }

    if (event.target.closest('[data-pop-sort]') && openFilter) {
      const dir = event.target.closest('[data-pop-sort]').dataset.popSort;
      const ts = state.tableState[openFilter.tableId];
      ts.sortKey = openFilter.colKey;
      ts.sortDir = dir;
      closePopover();
      rerenderContent();
      return;
    }

    if (event.target.closest('[data-pop-clear]') && openFilter) {
      state.tableState[openFilter.tableId].filters[openFilter.colKey] = [];
      closePopover();
      rerenderContent();
      return;
    }

    if (event.target.closest('[data-pop-apply]') && openFilter) {
      const checked = [...el('filterPopover').querySelectorAll('[data-pop-value]:checked')].map(input => input.dataset.popValue);
      state.tableState[openFilter.tableId].filters[openFilter.colKey] = checked;
      state.tableState[openFilter.tableId].page = 1;
      closePopover();
      rerenderContent();
      return;
    }

    if (!event.target.closest('#filterPopover') && !event.target.closest('[data-table-filter]')) closePopover();
  });

  document.addEventListener('input', event => {
    if (event.target.matches('[data-multi-search]')) {
      const query = event.target.value.trim().toLowerCase();
      const details = event.target.closest('[data-filter-details]');
      details.querySelectorAll('.sidebar-filter-option').forEach(option => {
        option.hidden = Boolean(query && !String(option.dataset.optionSearch || '').includes(query));
      });
      return;
    }

    if (event.target.matches('[data-table-search]')) {
      const id = event.target.dataset.tableSearch;
      state.tableState[id].search = event.target.value;
      state.tableState[id].page = 1;
      clearTimeout(event.target._timer);
      event.target._timer = setTimeout(rerenderContent, 180);
      return;
    }

    if (event.target.id === 'filterValueSearch' && openFilter) {
      el('filterValueList').innerHTML = filterValueHtml(openFilter.values, openFilter.selected, event.target.value);
    }
  });

  document.addEventListener('change', event => {
    if (event.target.matches('[data-filter="metric"]')) {
      state.metric = event.target.value;
      state.tableState = {};
      renderAll();
      return;
    }

    if (event.target.matches('[data-table-size]')) {
      const id = event.target.dataset.tableSize;
      state.tableState[id].pageSize = num(event.target.value);
      state.tableState[id].page = 1;
      rerenderContent();
      return;
    }

    if (event.target.matches('[data-pop-value]') && openFilter) {
      const value = event.target.dataset.popValue;
      if (event.target.checked) openFilter.selected.add(value);
      else openFilter.selected.delete(value);
    }
  });

  el('clearFilters')?.addEventListener('click', clearGlobalFilters);
  el('refreshData')?.addEventListener('click', () => loadData(true));
  el('exportCurrent')?.addEventListener('click', exportCurrent);
  window.addEventListener('resize', closePopover);

  loadData();
})();
