(() => {
  'use strict';

  const ALL = '__all__';
  const PAGE_SIZE = 25;
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
    leader: ['Regional Head Performance', 'All Regional Heads from the Zone Distribution master, including leaders with zero sales coverage.'],
    zonal: ['Zonal Performance', 'All zones from the Zone Distribution master, including zones with zero sales coverage.'],
    outlet: ['Outlet Performance', 'Outlet-level current versus last-year performance with master hierarchy.'],
    sku: ['SKU & Category Analysis', 'Interactive category and SKU tables with separate growth and de-growth drivers.'],
    detail: ['Detailed Data', 'Power BI-style searchable, movable, filterable and exportable detail tables.'],
    quality: ['Data Quality', 'Coverage, duplicate checks, hierarchy mismatches and source processing diagnostics.'],
    reports: ['Reports & Export', 'Download complete or filtered analysis as CSV and JSON.']
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
    tableState: {},
    skuChunks: new Map(),
    loading: false
  };
  const runtimeTables = new Map();
  let openFilter = null;

  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const text = value => String(value ?? '').trim();
  const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const unique = values => [...new Set(values.filter(v => text(v) !== ''))].sort((a,b) => String(a).localeCompare(String(b), undefined, {numeric:true, sensitivity:'base'}));
  const by = (arr, key, value) => arr.filter(x => x?.[key] === value);
  const bdCompactNumber = value => {
    const n = num(value);
    const absoluteValue = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    const scaled = divisor => new Intl.NumberFormat('en-US', {
      maximumFractionDigits: 1
    }).format(absoluteValue / divisor);

    if (absoluteValue >= 10000000) return `${sign}${scaled(10000000)} Cr`;
    if (absoluteValue >= 100000) return `${sign}${scaled(100000)} Lac`;
    if (absoluteValue >= 1000) return `${sign}${scaled(1000)} K`;

    return `${sign}${new Intl.NumberFormat('en-US', {
      maximumFractionDigits: 2
    }).format(absoluteValue)}`;
  };
  const compactNumber = value => bdCompactNumber(value);
  const fullNumber = value => bdCompactNumber(value);
  const money = value => `৳${bdCompactNumber(value)}`;
  const pct = value => value == null ? '—' : `${num(value).toFixed(1)}%`;
  const dateFmt = value => {
    if (!value) return 'Not generated';
    const d = new Date(value);
    return Number.isNaN(d.valueOf()) ? String(value) : d.toLocaleString('en-GB', {dateStyle:'medium', timeStyle:'short'});
  };
  const statusLabel = status => ({growth:'Growing', degrowth:'De-growing', flat:'Flat', new:'New (LY=0)', inactive:'Inactive', no_data:'No data'}[status] || status || 'No data');
  const statusBadge = status => `<span class="status status-${esc(status || 'flat')}">${esc(statusLabel(status))}</span>`;
  const metricDef = () => METRICS[state.metric];

  function rawMetric(values, metric = state.metric) {
    const a = Array.isArray(values) ? values : [];
    const agg = {
      sales_qty_this: num(a[0]), sales_qty_last: num(a[1]),
      sales_this: num(a[2]), sales_last: num(a[3]),
      ff_this: num(a[4]), ff_last: num(a[5]),
      gpv_this: num(a[6]), gpv_last: num(a[7])
    };
    if (metric === 'basket') {
      return metricResult(agg.ff_this ? agg.sales_this / agg.ff_this : 0, agg.ff_last ? agg.sales_last / agg.ff_last : 0);
    }
    const d = METRICS[metric];
    return metricResult(agg[d.thisKey], agg[d.lastKey]);
  }

  function metricResult(thisValue, lastValue) {
    const current = Math.abs(num(thisValue)) < 1e-9 ? 0 : num(thisValue);
    const last = Math.abs(num(lastValue)) < 1e-9 ? 0 : num(lastValue);
    const diff = current - last;
    let status = 'flat', growth = 0;
    if (last === 0) {
      if (current > 0) { status = 'new'; growth = null; }
      else if (current < 0) { status = 'degrowth'; growth = null; }
    } else {
      growth = diff / Math.abs(last) * 100;
      if (current === 0 && last > 0) status = 'inactive';
      else if (growth > 0.000001) status = 'growth';
      else if (growth < -0.000001) status = 'degrowth';
    }
    return {this: current, last, diff, growth, status, growth_note: last === 0 && current !== 0 ? 'Percentage growth is not defined because last-year value is zero.' : ''};
  }

  function entityMetric(entity, metric = state.metric) {
    return entity?.metrics?.[metric] || metricResult(0, 0);
  }

  function formatMetric(value, metric = state.metric) {
    return METRICS[metric]?.money ? money(value) : compactNumber(value);
  }

  async function loadData(force = false) {
    if (state.loading) return;
    state.loading = true;
    showToast('Loading dashboard data…');
    try {
      const suffix = force ? `?v=${Date.now()}` : '';
      const response = await fetch(`processed/dashboard_data.json${suffix}`, {cache: force ? 'reload' : 'default'});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.data = await response.json();
      normalizeData();
      renderAll();
      showToast('Dashboard data loaded.');
    } catch (error) {
      el('content').innerHTML = `<div class="card card-pad"><h2>Dashboard data could not be loaded</h2><p class="muted">${esc(error.message)}</p><div class="notice warning">Run the GitHub Actions workflow named <strong>Refresh data and deploy Pages</strong>. It downloads the Google Drive workbooks, rebuilds the compact JSON, validates it, and deploys the site.</div></div>`;
      showToast('Data load failed.');
    } finally {
      state.loading = false;
    }
  }

  function normalizeData() {
    const d = state.data;
    d.regions ||= [];
    d.zones ||= [];
    d.outlets ||= [];
    d.categories ||= [];
    d.sku_catalog ||= [];
    d.sku_drivers ||= {overall:{positive:[],negative:[],top_sales:[]}, regions:{}, zones:{}, outlets:{}};
    d.meta ||= {};
    d.data_quality ||= {};
    d.overall ||= {metrics:{}};
    d.regions.forEach(r => { r.regional_key ||= r.regional_id || r.regional_name || 'UNMAPPED-REGION'; });
    d.zones.forEach(z => { z.zone_key ||= `${z.regional_key || z.regional_id || z.regional_name || 'UNMAPPED-REGION'}|${z.zonal_id || z.zonal_name || 'UNMAPPED-ZONE'}`; });
    d.outlets.forEach(o => {
      o.regional_key ||= o.regional_id || o.regional_name || 'UNMAPPED-REGION';
      o.zone_key ||= `${o.regional_key}|${o.zonal_id || o.zonal_name || 'UNMAPPED-ZONE'}`;
      if (o.is_active == null) o.is_active = true;
      if (o.has_performance == null) o.has_performance = Object.values(o.metrics || {}).some(m => num(m.this) !== 0 || num(m.last) !== 0);
    });
  }

  function renderAll() {
    renderNav();
    renderFilterBar();
    renderPage();
    const meta = state.data?.meta || {};
    el('dataStamp').innerHTML = `Generated: ${esc(dateFmt(meta.generated_at))}<br>${fullNumber(meta.total_rows_used || 0)} processed rows`;
  }

  function renderNav() {
    el('nav').innerHTML = NAV.map(([id, icon, label]) => `<button class="nav-btn ${state.page === id ? 'active' : ''}" data-nav="${id}" type="button"><span class="nav-icon">${icon}</span>${esc(label)}</button>`).join('');
  }

  function filteredZones() {
    return state.data.zones.filter(z => state.regional === ALL || z.regional_key === state.regional);
  }
  function filteredOutletsBase() {
    return state.data.outlets.filter(o =>
      (state.regional === ALL || o.regional_key === state.regional) &&
      (state.zone === ALL || o.zone_key === state.zone)
    );
  }
  function hierarchyFilteredOutlets() {
    return filteredOutletsBase().filter(o => state.outlet === ALL || o.outlet_code === state.outlet);
  }
  function categoryRows() {
    return state.data.categories.filter(r =>
      (state.regional === ALL || r.regional_key === state.regional) &&
      (state.zone === ALL || r.zone_key === state.zone) &&
      (state.outlet === ALL || r.outlet_code === state.outlet) &&
      (state.division === ALL || r.division === state.division) &&
      (state.cat01 === ALL || r.cat01 === state.cat01) &&
      (state.cat03 === ALL || r.cat03 === state.cat03)
    );
  }

  function options(values, selected, allLabel) {
    return `<option value="${ALL}">${esc(allLabel)}</option>` + values.map(v => `<option value="${esc(v.value ?? v)}" ${(v.value ?? v) === selected ? 'selected' : ''}>${esc(v.label ?? v)}</option>`).join('');
  }

  function renderFilterBar() {
    const regions = state.data.regions.map(r => ({value:r.regional_key, label:r.regional_name || r.regional_id || r.regional_key}));
    const zones = filteredZones().map(z => ({value:z.zone_key, label:z.zonal_name || z.zonal_id || z.zone_key}));
    const outlets = filteredOutletsBase().map(o => ({value:o.outlet_code, label:`${o.outlet_code} — ${o.outlet_name || ''}`}));
    const cats = state.data.categories;
    const divisions = unique(cats.map(x => x.division));
    const cat01 = unique(cats.filter(x => state.division === ALL || x.division === state.division).map(x => x.cat01));
    const cat03 = unique(cats.filter(x => (state.division === ALL || x.division === state.division) && (state.cat01 === ALL || x.cat01 === state.cat01)).map(x => x.cat03));
    el('filterBar').innerHTML = `
      <div class="filter-group"><label>Metric</label><select data-filter="metric">${Object.entries(METRICS).map(([k,v]) => `<option value="${k}" ${state.metric===k?'selected':''}>${esc(v.label)}</option>`).join('')}</select></div>
      <div class="filter-group"><label>Regional Head</label><select data-filter="regional">${options(regions, state.regional, 'All Regional Heads')}</select></div>
      <div class="filter-group"><label>Zonal Name</label><select data-filter="zone">${options(zones, state.zone, 'All Zones')}</select></div>
      <div class="filter-group" style="min-width:230px"><label>Outlet</label><select data-filter="outlet">${options(outlets, state.outlet, 'All Outlets')}</select></div>
      <div class="filter-group"><label>Division</label><select data-filter="division">${options(divisions, state.division, 'All Divisions')}</select></div>
      <div class="filter-group"><label>Cat 01</label><select data-filter="cat01">${options(cat01, state.cat01, 'All Cat 01')}</select></div>
      <div class="filter-group"><label>Cat 03</label><select data-filter="cat03">${options(cat03, state.cat03, 'All Cat 03')}</select></div>
      ${state.viewStatus !== ALL ? `<span class="filter-chip">Status: ${esc(statusLabel(state.viewStatus))}<button data-clear-status type="button">×</button></span>` : ''}
    `;
  }

  function renderPage() {
    runtimeTables.clear();
    const meta = PAGE_META[state.page] || PAGE_META.executive;
    el('pageTitle').textContent = meta[0];
    el('pageSubtitle').textContent = meta[1];
    const renderers = {executive:renderExecutive, leader:renderLeader, zonal:renderZonal, outlet:renderOutlet, sku:renderSku, detail:renderDetail, quality:renderQuality, reports:renderReports};
    el('content').innerHTML = (renderers[state.page] || renderExecutive)();
    attachDragHandlers();
  }

  function aggregateMetricFromRows(rows) {
    const sums = [0,0,0,0,0,0,0,0];
    rows.forEach(r => (r.values || []).forEach((v,i) => sums[i] += num(v)));
    return rawMetric(sums);
  }

  function selectedMetric() {
    const anyFilter = state.division !== ALL || state.cat01 !== ALL || state.cat03 !== ALL || state.outlet !== ALL || state.zone !== ALL || state.regional !== ALL;
    if (!anyFilter) return entityMetric(state.data.overall, state.metric);
    // Category cube retains the additive source fields, so Basket Size is correctly
    // recalculated as aggregated Sales / aggregated FF instead of summing outlet baskets.
    if (state.data.categories.length) return aggregateMetricFromRows(categoryRows());
    const outlets = hierarchyFilteredOutlets();
    const totals = outlets.reduce((acc, o) => {
      const m = entityMetric(o);
      acc.this += num(m.this); acc.last += num(m.last); return acc;
    }, {this:0,last:0});
    return metricResult(totals.this, totals.last);
  }

  function performanceCounts() {
    const rows = hierarchyFilteredOutlets();
    const counts = {growth:0, degrowth:0, flat:0, new:0, inactive:0, active:0, total:rows.length, withData:0};
    rows.forEach(o => {
      const m = entityMetric(o);
      counts[m.status] = (counts[m.status] || 0) + 1;
      if (o.is_active !== false) counts.active++;
      if (o.has_performance) counts.withData++;
    });
    return counts;
  }

  function kpiCard(label, value, sub, cls='') {
    return `<article class="card kpi"><span class="kpi-label">${esc(label)}</span><strong class="kpi-value ${cls}">${value}</strong><div class="kpi-sub">${sub}</div></article>`;
  }

  function renderExecutive() {
    const m = selectedMetric();
    const c = performanceCounts();
    const currentCls = m.status === 'degrowth' || m.status === 'inactive' ? 'bad' : m.status === 'growth' || m.status === 'new' ? 'good' : '';
    const allRows = hierarchyFilteredOutlets().map(o => ({...o, _metric:entityMetric(o)}));
    const growing = allRows.filter(r => r._metric.status === 'growth').sort((a,b)=>b._metric.diff-a._metric.diff).slice(0,10);
    const falling = allRows.filter(r => r._metric.status === 'degrowth' || r._metric.status === 'inactive').sort((a,b)=>a._metric.diff-b._metric.diff).slice(0,10);
    const fallback = state.data.meta?.package_note ? `<div class="notice warning" style="margin-bottom:16px"><strong>Data refresh required.</strong> ${esc(state.data.meta.package_note)}</div>` : '';
    return `${fallback}
      <div class="grid kpi-grid">
        ${kpiCard(`${metricDef().label} This`, formatMetric(m.this), `Current selected scope · ${statusBadge(m.status)}`, currentCls)}
        ${kpiCard(`${metricDef().label} Last`, formatMetric(m.last), m.last === 0 ? 'No last-year base in the selected scope' : 'Comparable last-year value')}
        ${kpiCard('Difference', formatMetric(m.diff), `Absolute change from last year`, m.diff < 0 ? 'bad' : m.diff > 0 ? 'good' : '')}
        ${kpiCard('Growth %', pct(m.growth), m.last === 0 && m.this !== 0 ? 'Not calculated: last-year value is zero' : 'Difference ÷ absolute last-year value', m.growth < 0 ? 'bad' : m.growth > 0 ? 'good' : '')}
      </div>
      <div class="grid two-col">
        <section class="card">
          <div class="card-head"><div><h2>Performance Summary</h2><p>Counts use every outlet in the Zone Distribution master for the selected hierarchy.</p></div></div>
          <div class="summary-grid">
            ${summaryTile('Active Outlets', c.active, 'Master operational status')}
            ${summaryTile('Sales-covered Outlets', c.withData, 'Has current/last performance')}
            ${summaryTile('Total Master Outlets', c.total, 'All mapped outlets')}
            ${summaryTile('Growing', c.growth, `<button class="btn btn-small btn-secondary" data-action="view-status" data-status="growth">View all</button>`)}
            ${summaryTile('De-growing', c.degrowth + c.inactive, `<button class="btn btn-small btn-secondary" data-action="view-status" data-status="degrowth">View all</button>`)}
            ${summaryTile('New (LY=0)', c.new, `<button class="btn btn-small btn-secondary" data-action="view-status" data-status="new">View all</button>`)}
          </div>
          <div class="card-pad" style="padding-top:0"><div class="notice">When <strong>Sales Last = 0</strong> and current sales are positive, the outlet/SKU is classified as <strong>New (LY=0)</strong>. The percentage is deliberately blank because division by zero is undefined; the absolute difference still equals current sales.</div></div>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>Network Coverage</h2><p>Master hierarchy versus processed sales coverage.</p></div></div>
          ${coveragePanel()}
        </section>
      </div>
      <div class="grid equal-col" style="margin-top:16px">
        ${barPanel('Top Growing Outlets', growing, false, 'growth')}
        ${barPanel('Largest De-growth Outlets', falling, true, 'degrowth')}
      </div>
    `;
  }

  function summaryTile(label, value, foot) {
    return `<div class="summary-tile"><span class="muted">${esc(label)}</span><strong>${fullNumber(value)}</strong><div style="margin-top:7px">${foot}</div></div>`;
  }

  function coveragePanel() {
    const cov = state.data.meta?.coverage || {};
    const items = [
      ['Master outlets', cov.master_outlets ?? state.data.outlets.length],
      ['Performance outlets', cov.performance_outlets ?? state.data.outlets.filter(o=>o.has_performance).length],
      ['Matched to master', cov.matched_outlets ?? 0],
      ['Master without performance', cov.master_without_performance ?? 0],
      ['Regional Heads', state.data.meta?.region_count ?? state.data.regions.length],
      ['Zones', state.data.meta?.zone_count ?? state.data.zones.length]
    ];
    return `<div class="summary-grid">${items.map(([a,b]) => summaryTile(a,b,'')).join('')}</div>`;
  }

  function barPanel(title, rows, negative, status) {
    const max = Math.max(1, ...rows.map(r => Math.abs(r._metric.diff)));
    return `<section class="card"><div class="card-head"><div><h2>${esc(title)}</h2><p>${esc(metricDef().label)} absolute difference.</p></div><button class="btn btn-small btn-secondary" data-action="view-status" data-status="${status}" type="button">View all</button></div>
      ${rows.length ? `<div class="chart-list">${rows.map(r => `<div class="bar-row"><span class="bar-label" title="${esc(r.outlet_name)}">${esc(r.outlet_code)} · ${esc(r.outlet_name)}</span><span class="bar-track"><span class="bar-fill ${negative?'negative':''}" style="width:${Math.max(2,Math.abs(r._metric.diff)/max*100)}%"></span></span><span class="bar-value ${r._metric.diff<0?'bad':'good'}">${esc(formatMetric(r._metric.diff))}</span></div>`).join('')}</div>` : `<div class="empty">No matching outlets.</div>`}
    </section>`;
  }

  function hierarchyRows(level) {
    let rows;
    if (level === 'region') rows = state.data.regions.filter(r => state.regional === ALL || r.regional_key === state.regional);
    else if (level === 'zone') rows = state.data.zones.filter(z => (state.regional===ALL || z.regional_key===state.regional) && (state.zone===ALL || z.zone_key===state.zone));
    else rows = hierarchyFilteredOutlets();
    return rows.map(r => ({...r, _metric:entityMetric(r)})).filter(r => state.viewStatus === ALL || (state.viewStatus === 'degrowth' ? ['degrowth','inactive'].includes(r._metric.status) : r._metric.status === state.viewStatus));
  }

  function performanceColumns(level) {
    const cols = [];
    if (level !== 'region') cols.push({key:'regional_name', label:'Regional Head'});
    if (level === 'zone' || level === 'outlet') cols.push({key:'zonal_name', label:'Zonal Name'});
    if (level === 'outlet') cols.push({key:'outlet_code', label:'Outlet Code'}, {key:'outlet_name', label:'Outlet Name', wrap:true});
    if (level === 'region') cols.push({key:'regional_id', label:'Regional ID'}, {key:'regional_name', label:'Regional Head'});
    if (level === 'zone') cols.push({key:'zonal_id', label:'Zonal ID'});
    cols.push(
      {key:'active_outlet_count', label:'Active Outlets', type:'number', value:r=>r.active_outlet_count ?? (level==='outlet' ? (r.is_active!==false?1:0) : 0)},
      {key:'performance_outlet_count', label:'Sales-covered', type:'number', value:r=>r.performance_outlet_count ?? (level==='outlet' ? (r.has_performance?1:0) : 0)},
      {key:'outlet_count', label:'Total Outlets', type:'number', value:r=>r.outlet_count ?? (level==='outlet'?1:0)},
      {key:'metric_this', label:`${metricDef().label} This`, type:'number', value:r=>r._metric.this, render:r=>formatMetric(r._metric.this)},
      {key:'metric_last', label:`${metricDef().label} Last`, type:'number', value:r=>r._metric.last, render:r=>formatMetric(r._metric.last)},
      {key:'metric_diff', label:'Difference', type:'number', value:r=>r._metric.diff, render:r=>`<span class="${r._metric.diff<0?'bad':r._metric.diff>0?'good':''}">${esc(formatMetric(r._metric.diff))}</span>`},
      {key:'metric_growth', label:'Growth %', type:'number', value:r=>r._metric.growth, render:r=>r._metric.last===0&&r._metric.this!==0?'—':pct(r._metric.growth)},
      {key:'metric_status', label:'Status', value:r=>statusLabel(r._metric.status), render:r=>statusBadge(r._metric.status)}
    );
    return cols;
  }

  function renderLeader() {
    const rows = hierarchyRows('region');
    return tableCard('regional-performance', 'Sales Growth % by Regional Head', 'The table is seeded from Zone Distribution first; leaders without sales rows remain visible with zero values.', performanceColumns('region'), rows, {sortKey:'metric_diff', sortDir:'desc'});
  }
  function renderZonal() {
    const rows = hierarchyRows('zone');
    return tableCard('zonal-performance', 'Sales Growth % by Zonal Name', 'All master zones are included, even when the performance workbooks contain no rows for the zone.', performanceColumns('zone'), rows, {sortKey:'metric_diff', sortDir:'desc'});
  }
  function renderOutlet() {
    const rows = hierarchyRows('outlet');
    const cols = performanceColumns('outlet').concat([
      {key:'format', label:'Format'}, {key:'ownership_status', label:'Ownership'}, {key:'location_type', label:'Location Type'},
      {key:'sft', label:'SFT', type:'number'}, {key:'master_status', label:'Master Status', value:r=>r.is_active===false?'Inactive':'Active'}
    ]);
    return tableCard('outlet-performance', 'Outlet Performance', 'Click any header to sort; use the filter icon for searchable multi-select filtering; drag headers to reorder.', cols, rows, {sortKey:'metric_diff', sortDir:'desc'});
  }

  function categorySummaryRows() {
    const map = new Map();
    categoryRows().forEach(r => {
      const key = `${r.division}|${r.cat01}|${r.cat03}`;
      if (!map.has(key)) map.set(key, {division:r.division, cat01:r.cat01, cat03:r.cat03, values:[0,0,0,0,0,0,0,0]});
      r.values.forEach((v,i)=>map.get(key).values[i]+=num(v));
    });
    return [...map.values()].map(r=>({...r,_metric:rawMetric(r.values)}));
  }

  function skuRows() {
    return state.data.sku_catalog.filter(r =>
      (state.division===ALL || r.division===state.division) &&
      (state.cat01===ALL || r.cat01===state.cat01) &&
      (state.cat03===ALL || r.cat03===state.cat03)
    ).map(r=>({...r,_metric:rawMetric(r.values)}));
  }

  function productColumns(kind) {
    const idCols = kind === 'sku' ? [{key:'sku',label:'SKU'}, {key:'sku_name',label:'SKU Name',wrap:true}] : [];
    return idCols.concat([
      {key:'division',label:'Division'}, {key:'cat01',label:'Cat 01'}, {key:'cat03',label:'Cat 03'},
      {key:'this',label:`${metricDef().label} This`,type:'number',value:r=>r._metric.this,render:r=>formatMetric(r._metric.this)},
      {key:'last',label:`${metricDef().label} Last`,type:'number',value:r=>r._metric.last,render:r=>formatMetric(r._metric.last)},
      {key:'diff',label:'Difference',type:'number',value:r=>r._metric.diff,render:r=>`<span class="${r._metric.diff<0?'bad':r._metric.diff>0?'good':''}">${esc(formatMetric(r._metric.diff))}</span>`},
      {key:'growth',label:'Growth %',type:'number',value:r=>r._metric.growth,render:r=>r._metric.last===0&&r._metric.this!==0?'—':pct(r._metric.growth)},
      {key:'status',label:'Status',value:r=>statusLabel(r._metric.status),render:r=>statusBadge(r._metric.status)}
    ]);
  }

  function currentDriverSet() {
    const drivers = state.data.sku_drivers || {};
    if (state.outlet !== ALL) return drivers.outlets?.[state.outlet] || {positive:[],negative:[],top_sales:[]};
    if (state.zone !== ALL) return drivers.zones?.[state.zone] || {positive:[],negative:[],top_sales:[]};
    if (state.regional !== ALL) return drivers.regions?.[state.regional] || {positive:[],negative:[],top_sales:[]};
    return drivers.overall || {positive:[],negative:[],top_sales:[]};
  }

  function renderSku() {
    const cats = categorySummaryRows();
    const skus = skuRows();
    const drv = currentDriverSet();
    const growth = (drv.positive || []).map(r=>({...r,_metric:entityMetric(r)}));
    const decline = (drv.negative || []).map(r=>({...r,_metric:entityMetric(r)}));
    return `
      <div class="grid equal-col">
        ${tableCard('sku-growth-drivers','SKU Growth Drivers','SKUs with the largest positive absolute sales contribution.',productColumns('sku'),growth,{sortKey:'diff',sortDir:'desc'})}
        ${tableCard('sku-degrowth-drivers','SKU De-growth Drivers','SKUs with the largest negative absolute sales contribution.',productColumns('sku'),decline,{sortKey:'diff',sortDir:'asc'})}
      </div>
      <div style="height:16px"></div>
      ${tableCard('category-analysis','Category Analysis','Division / Cat 01 / Cat 03 performance.',productColumns('category'),cats,{sortKey:'diff',sortDir:'desc'})}
      <div style="height:16px"></div>
      ${tableCard('sku-analysis','All SKU Analysis','Search, filter, sort, drag columns and export the complete SKU catalog.',productColumns('sku'),skus,{sortKey:'this',sortDir:'desc'})}
    `;
  }

  function renderDetail() {
    const outletCols = performanceColumns('outlet').concat([{key:'format',label:'Format'},{key:'ownership_status',label:'Ownership'},{key:'division',label:'Division'},{key:'location_type',label:'Location Type'}]);
    const categoryDetail = categoryRows().map(r=>({...r,_metric:rawMetric(r.values)}));
    return `
      ${tableCard('detail-outlets','Detailed Outlet Data','Every outlet from master hierarchy; all column headers include Excel-style controls.',outletCols,hierarchyRows('outlet'),{sortKey:'outlet_code',sortDir:'asc'})}
      <div style="height:16px"></div>
      ${tableCard('detail-category','Detailed Category Data','Outlet-by-category cube for the current hierarchy and category filters.',[
        {key:'outlet_code',label:'Outlet Code'},{key:'division',label:'Division'},{key:'cat01',label:'Cat 01'},{key:'cat03',label:'Cat 03'},...productColumns('category').slice(3)
      ],categoryDetail,{sortKey:'diff',sortDir:'desc'})}
      <div style="height:16px"></div>
      ${tableCard('detail-sku','Detailed SKU Catalog','Compact SKU catalog. Hierarchy-specific driver tables are available on SKU & Category Analysis.',productColumns('sku'),skuRows(),{sortKey:'sku',sortDir:'asc'})}
    `;
  }

  function renderQuality() {
    const m = state.data.meta || {};
    const q = state.data.data_quality || {};
    const files = m.performance_files || [];
    const fileCols = [
      {key:'file',label:'Source File',wrap:true},{key:'sheet_name',label:'Sheet'},{key:'header_row',label:'Header Row',type:'number'},
      {key:'rows_read',label:'Rows Read',type:'number'},{key:'rows_used',label:'Rows Used',type:'number'},{key:'outlets',label:'Outlets',type:'number'},
      {key:'missing_headers',label:'Missing Headers',value:r=>(r.missing_headers||[]).join(', '),wrap:true}
    ];
    const warnings = (q.warnings || []).map((x,i)=>({id:i+1,type:x.type||'warning',file:x.file||'',details:Array.isArray(x.details)?x.details.join(', '):JSON.stringify(x.details||'')}));
    return `
      <div class="grid kpi-grid">
        ${kpiCard('Rows Read',fullNumber(m.total_rows_read||0),'Across all performance files')}
        ${kpiCard('Rows Used',fullNumber(m.total_rows_used||0),'After validation and duplicate removal')}
        ${kpiCard('Duplicate Records',fullNumber(m.duplicate_records||0),'Duplicate Outlet Code + SKU excluded')}
        ${kpiCard('Invalid Rows',fullNumber(m.invalid_rows||0),'Missing outlet code or SKU')}
      </div>
      ${tableCard('source-files','Source Processing','Workbook and selected worksheet details.',fileCols,files,{sortKey:'file',sortDir:'asc'})}
      <div style="height:16px"></div>
      ${tableCard('quality-warnings','Warnings','Missing headers and source validation warnings.',[{key:'id',label:'#',type:'number'},{key:'type',label:'Type'},{key:'file',label:'File',wrap:true},{key:'details',label:'Details',wrap:true}],warnings,{sortKey:'id',sortDir:'asc'})}
    `;
  }

  function renderReports() {
    const reports = [
      ['regional','Regional Head Performance','All Regional Heads from master with current metric values.'],
      ['zonal','Zonal Performance','All master zones with hierarchy and coverage fields.'],
      ['outlet','Outlet Performance','Filtered outlet-level performance and master attributes.'],
      ['category','Category Analysis','Filtered Division / Cat 01 / Cat 03 analysis.'],
      ['sku','SKU Analysis','Filtered compact SKU performance catalog.'],
      ['drivers-growth','SKU Growth Drivers','Positive SKU contribution table for the selected hierarchy.'],
      ['drivers-degrowth','SKU De-growth Drivers','Negative SKU contribution table for the selected hierarchy.'],
      ['quality','Data Quality JSON','Full quality findings and build metadata.'],
      ['snapshot','Complete Dashboard JSON','Processed dashboard snapshot for backup or downstream use.']
    ];
    return `<section class="card"><div class="card-head"><div><h2>Reports & Export</h2><p>Downloads are generated in-browser and work on GitHub Pages without a server.</p></div></div><div class="card-pad"><div class="report-grid">${reports.map(([id,title,desc])=>`<article class="report-card"><h3>${esc(title)}</h3><p>${esc(desc)}</p><button class="btn btn-primary" data-report="${id}" type="button">Download</button></article>`).join('')}</div></div></section>`;
  }

  function tableCard(id, title, subtitle, columns, rows, defaults={}) {
    return `<section class="card smart-table-card"><div class="card-head"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div></div>${smartTable(id, columns, rows, defaults)}</section>`;
  }

  function tableCellValue(col, row) {
    return col.value ? col.value(row) : row?.[col.key];
  }

  function smartTable(id, columns, rows, defaults={}) {
    if (!state.tableState[id]) state.tableState[id] = {search:'', sortKey:defaults.sortKey || columns[0]?.key, sortDir:defaults.sortDir || 'asc', filters:{}, order:columns.map(c=>c.key), page:1, pageSize:PAGE_SIZE};
    const ts = state.tableState[id];
    const colMap = new Map(columns.map(c=>[c.key,c]));
    ts.order = ts.order.filter(k=>colMap.has(k)).concat(columns.map(c=>c.key).filter(k=>!ts.order.includes(k)));
    const ordered = ts.order.map(k=>colMap.get(k));
    runtimeTables.set(id,{columns:ordered, rows});
    const processed = processRows(id, ordered, rows);
    const pages = Math.max(1, Math.ceil(processed.length / ts.pageSize));
    ts.page = Math.min(Math.max(1,ts.page),pages);
    const pageRows = processed.slice((ts.page-1)*ts.pageSize, ts.page*ts.pageSize);
    return `<div class="smart-table" data-table="${id}">
      <div class="table-toolbar">
        <input type="search" data-table-search="${id}" value="${esc(ts.search)}" placeholder="Search this table…">
        <label class="muted">Rows <select data-table-size="${id}">${[10,25,50,100,250].map(n=>`<option ${ts.pageSize===n?'selected':''}>${n}</option>`).join('')}</select></label>
        <button class="btn btn-small btn-secondary" data-table-reset="${id}" type="button">Reset table</button>
        <button class="btn btn-small btn-primary" data-table-export="${id}" type="button">Export CSV</button>
        <span class="table-count">${fullNumber(processed.length)} of ${fullNumber(rows.length)} rows</span>
      </div>
      <div class="table-wrap"><table><thead><tr>${ordered.map(c=>{
        const active = ts.filters[c.key]?.length;
        const sort = ts.sortKey===c.key ? `<span class="sort-mark">${ts.sortDir==='asc'?'▲':'▼'}</span>` : '';
        return `<th draggable="true" data-drag-table="${id}" data-col="${esc(c.key)}"><div class="th-inner"><button class="th-sort" data-table-sort="${id}" data-col="${esc(c.key)}" type="button">${esc(c.label)} ${sort}</button><button class="th-filter ${active?'active':''}" data-table-filter="${id}" data-col="${esc(c.key)}" type="button" title="Filter ${esc(c.label)}">▼</button></div></th>`;
      }).join('')}</tr></thead><tbody>${pageRows.length?pageRows.map(r=>`<tr>${ordered.map(c=>{
        const raw=tableCellValue(c,r); const rendered=c.render?c.render(r):esc(raw ?? '');
        return `<td class="${c.type==='number'?'cell-number':''} ${c.wrap?'cell-wrap':''}">${rendered}</td>`;
      }).join('')}</tr>`).join(''):`<tr><td colspan="${ordered.length}"><div class="empty">No rows match the current filters.</div></td></tr>`}</tbody></table></div>
      <div class="table-pagination"><button class="page-btn" data-table-page="${id}" data-page="${ts.page-1}" ${ts.page<=1?'disabled':''}>‹</button>${pageButtons(ts.page,pages).map(p=>p==='…'?`<span>…</span>`:`<button class="page-btn ${p===ts.page?'active':''}" data-table-page="${id}" data-page="${p}">${p}</button>`).join('')}<button class="page-btn" data-table-page="${id}" data-page="${ts.page+1}" ${ts.page>=pages?'disabled':''}>›</button></div>
    </div>`;
  }

  function processRows(id, columns, rows) {
    const ts = state.tableState[id];
    let out = [...rows];
    const q = text(ts.search).toLowerCase();
    if (q) out = out.filter(r=>columns.some(c=>text(tableCellValue(c,r)).toLowerCase().includes(q)));
    Object.entries(ts.filters).forEach(([key,values])=>{
      if (!values?.length) return;
      const col=columns.find(c=>c.key===key); if (!col) return;
      const set=new Set(values.map(String));
      out=out.filter(r=>set.has(String(tableCellValue(col,r) ?? '')));
    });
    const sortCol=columns.find(c=>c.key===ts.sortKey);
    if (sortCol) out.sort((a,b)=>compare(tableCellValue(sortCol,a),tableCellValue(sortCol,b),sortCol.type)* (ts.sortDir==='desc'?-1:1));
    return out;
  }

  function compare(a,b,type) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (type==='number' || (Number.isFinite(Number(a)) && Number.isFinite(Number(b)))) return num(a)-num(b);
    return String(a).localeCompare(String(b),undefined,{numeric:true,sensitivity:'base'});
  }

  function pageButtons(current,total) {
    if (total<=7) return Array.from({length:total},(_,i)=>i+1);
    const p=[1]; if(current>4)p.push('…');
    for(let i=Math.max(2,current-1);i<=Math.min(total-1,current+1);i++)p.push(i);
    if(current<total-3)p.push('…'); p.push(total); return p;
  }

  function rerenderContent() { renderPage(); }

  function openColumnFilter(tableId, colKey, button) {
    const rt=runtimeTables.get(tableId); const ts=state.tableState[tableId]; if(!rt||!ts)return;
    const col=rt.columns.find(c=>c.key===colKey); if(!col)return;
    const values=unique(rt.rows.map(r=>String(tableCellValue(col,r) ?? '')));
    const selected=new Set((ts.filters[colKey]||[]).map(String));
    openFilter={tableId,colKey,values,selected,col};
    const pop=el('filterPopover');
    pop.innerHTML=`<div class="filter-popover-head"><strong>${esc(col.label)}</strong><input id="filterValueSearch" type="search" placeholder="Search values…"><div class="filter-sort-actions"><button class="btn btn-small btn-secondary" data-pop-sort="asc">Sort smallest / A–Z</button><button class="btn btn-small btn-secondary" data-pop-sort="desc">Sort largest / Z–A</button></div></div><div id="filterValueList" class="filter-values">${filterValueHtml(values,selected)}</div><div class="filter-popover-foot"><button class="btn btn-small btn-secondary" data-pop-clear type="button">Clear</button><button class="btn btn-small btn-primary" data-pop-apply type="button">Apply</button></div>`;
    const rect=button.getBoundingClientRect();
    pop.style.left=`${Math.min(window.innerWidth-342,Math.max(12,rect.left-270))}px`;
    pop.style.top=`${Math.min(window.innerHeight-500,rect.bottom+5)}px`;
    pop.hidden=false;
  }
  function filterValueHtml(values,selected,q='') {
    const query=q.toLowerCase();
    return values.filter(v=>v.toLowerCase().includes(query)).map(v=>`<label class="filter-option"><input type="checkbox" data-pop-value="${esc(v)}" ${selected.has(v)?'checked':''}><span>${esc(v||'(blank)')}</span></label>`).join('') || '<div class="empty">No values found.</div>';
  }
  function closePopover(){ el('filterPopover').hidden=true; openFilter=null; }

  function attachDragHandlers() {
    document.querySelectorAll('th[draggable="true"]').forEach(th=>{
      th.addEventListener('dragstart',e=>{th.classList.add('dragging');e.dataTransfer.setData('text/plain',`${th.dataset.dragTable}|${th.dataset.col}`)});
      th.addEventListener('dragend',()=>th.classList.remove('dragging'));
      th.addEventListener('dragover',e=>e.preventDefault());
      th.addEventListener('drop',e=>{
        e.preventDefault(); const [tableId,source]=e.dataTransfer.getData('text/plain').split('|');
        if(tableId!==th.dataset.dragTable)return; const target=th.dataset.col; const order=state.tableState[tableId].order;
        const s=order.indexOf(source),t=order.indexOf(target); if(s<0||t<0||s===t)return;
        order.splice(t,0,order.splice(s,1)[0]); rerenderContent();
      });
    });
  }

  function csvEscape(v){const s=String(v??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}
  function downloadBlob(name,content,type='text/csv;charset=utf-8'){
    const blob=new Blob([content],{type}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),500);showToast(`Downloaded ${name}`);
  }
  function exportTable(id){
    const rt=runtimeTables.get(id); if(!rt){showToast('No active table to export.');return;}
    const rows=processRows(id,rt.columns,rt.rows); const csv=[rt.columns.map(c=>csvEscape(c.label)).join(','),...rows.map(r=>rt.columns.map(c=>csvEscape(tableCellValue(c,r))).join(','))].join('\n');
    downloadBlob(`${id}-${new Date().toISOString().slice(0,10)}.csv`, '\ufeff'+csv);
  }
  function flattenPerformance(rows){return rows.map(r=>{const m=entityMetric(r);return {...r,metric:metricDef().label,metric_this:m.this,metric_last:m.last,difference:m.diff,growth_pct:m.growth,status:statusLabel(m.status)}});}
  function rowsToCsv(name,rows){if(!rows.length){showToast('No rows available for this report.');return;}const keys=[...new Set(rows.flatMap(Object.keys))].filter(k=>!['metrics','values','_metric'].includes(k));const csv=[keys.map(csvEscape).join(','),...rows.map(r=>keys.map(k=>csvEscape(typeof r[k]==='object'?JSON.stringify(r[k]):r[k])).join(','))].join('\n');downloadBlob(`${name}-${new Date().toISOString().slice(0,10)}.csv`,'\ufeff'+csv);}
  function downloadReport(id){
    if(id==='regional')return rowsToCsv('regional-performance',flattenPerformance(hierarchyRows('region')));
    if(id==='zonal')return rowsToCsv('zonal-performance',flattenPerformance(hierarchyRows('zone')));
    if(id==='outlet')return rowsToCsv('outlet-performance',flattenPerformance(hierarchyRows('outlet')));
    if(id==='category')return rowsToCsv('category-analysis',categorySummaryRows().map(r=>({...r,metric:metricDef().label,...r._metric})));
    if(id==='sku')return rowsToCsv('sku-analysis',skuRows().map(r=>({...r,metric:metricDef().label,...r._metric})));
    if(id==='drivers-growth'||id==='drivers-degrowth'){
      const d=currentDriverSet(); const rows=(id==='drivers-growth'?d.positive:d.negative).map(r=>({...r,...entityMetric(r)})); return rowsToCsv(id,rows);
    }
    if(id==='quality')return downloadBlob('dashboard-data-quality.json',JSON.stringify({meta:state.data.meta,data_quality:state.data.data_quality},null,2),'application/json');
    if(id==='snapshot')return downloadBlob('dashboard-data-snapshot.json',JSON.stringify(state.data,null,2),'application/json');
  }
  function exportCurrent(){const first=[...runtimeTables.keys()][0];if(first)exportTable(first);else showToast('This page has no exportable table.');}
  function showToast(message){const t=el('toast');t.textContent=message;t.hidden=false;clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>t.hidden=true,2600);}
  function clearGlobalFilters(){Object.assign(state,{regional:ALL,zone:ALL,outlet:ALL,division:ALL,cat01:ALL,cat03:ALL,viewStatus:ALL});state.tableState={};renderAll();}

  document.addEventListener('click', event => {
    const nav=event.target.closest('[data-nav]'); if(nav){state.page=nav.dataset.nav;state.viewStatus=ALL;renderAll();return;}
    const action=event.target.closest('[data-action="view-status"]'); if(action){state.viewStatus=action.dataset.status;state.page='outlet';renderAll();return;}
    if(event.target.closest('[data-clear-status]')){state.viewStatus=ALL;renderAll();return;}
    const sort=event.target.closest('[data-table-sort]'); if(sort){const ts=state.tableState[sort.dataset.tableSort];const k=sort.dataset.col;ts.sortDir=ts.sortKey===k&&ts.sortDir==='asc'?'desc':'asc';ts.sortKey=k;ts.page=1;rerenderContent();return;}
    const filter=event.target.closest('[data-table-filter]'); if(filter){openColumnFilter(filter.dataset.tableFilter,filter.dataset.col,filter);return;}
    const page=event.target.closest('[data-table-page]'); if(page&&!page.disabled){state.tableState[page.dataset.tablePage].page=num(page.dataset.page);rerenderContent();return;}
    const reset=event.target.closest('[data-table-reset]'); if(reset){delete state.tableState[reset.dataset.tableReset];rerenderContent();return;}
    const exportBtn=event.target.closest('[data-table-export]'); if(exportBtn){exportTable(exportBtn.dataset.tableExport);return;}
    const report=event.target.closest('[data-report]'); if(report){downloadReport(report.dataset.report);return;}
    if(event.target.closest('[data-pop-sort]')&&openFilter){const dir=event.target.closest('[data-pop-sort]').dataset.popSort;const ts=state.tableState[openFilter.tableId];ts.sortKey=openFilter.colKey;ts.sortDir=dir;closePopover();rerenderContent();return;}
    if(event.target.closest('[data-pop-clear]')&&openFilter){state.tableState[openFilter.tableId].filters[openFilter.colKey]=[];closePopover();rerenderContent();return;}
    if(event.target.closest('[data-pop-apply]')&&openFilter){const checked=[...el('filterPopover').querySelectorAll('[data-pop-value]:checked')].map(x=>x.dataset.popValue);state.tableState[openFilter.tableId].filters[openFilter.colKey]=checked;state.tableState[openFilter.tableId].page=1;closePopover();rerenderContent();return;}
    if(!event.target.closest('#filterPopover')&&!event.target.closest('[data-table-filter]'))closePopover();
  });

  document.addEventListener('input', event => {
    if(event.target.matches('[data-table-search]')){const id=event.target.dataset.tableSearch;state.tableState[id].search=event.target.value;state.tableState[id].page=1;clearTimeout(event.target._timer);event.target._timer=setTimeout(rerenderContent,180);}
    if(event.target.id==='filterValueSearch'&&openFilter){el('filterValueList').innerHTML=filterValueHtml(openFilter.values,openFilter.selected,event.target.value);}
  });

  document.addEventListener('change', event => {
    if(event.target.matches('[data-filter]')){
      const key=event.target.dataset.filter; state[key]=event.target.value;
      if(key==='regional'){state.zone=ALL;state.outlet=ALL;}
      if(key==='zone')state.outlet=ALL;
      if(key==='division'){state.cat01=ALL;state.cat03=ALL;}
      if(key==='cat01')state.cat03=ALL;
      state.tableState={};renderAll();
    }
    if(event.target.matches('[data-table-size]')){const id=event.target.dataset.tableSize;state.tableState[id].pageSize=num(event.target.value);state.tableState[id].page=1;rerenderContent();}
    if(event.target.matches('[data-pop-value]')&&openFilter){const v=event.target.dataset.popValue;if(event.target.checked)openFilter.selected.add(v);else openFilter.selected.delete(v);}
  });

  el('clearFilters').addEventListener('click',clearGlobalFilters);
  el('refreshData').addEventListener('click',()=>loadData(true));
  el('exportCurrent').addEventListener('click',exportCurrent);
  window.addEventListener('resize',closePopover);
  loadData();
})();
