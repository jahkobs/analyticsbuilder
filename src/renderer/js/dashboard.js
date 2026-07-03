'use strict';

import {
  gl, apAgeing, apInvoices, arAgeing, cashDaily, workforce, spend, inventory,
  pipeline, cashConversion, journalLines, dataFreshness, companies,
  MONTHS, LAST_REFRESH, formatMoney, formatNumber, ENTERPRISE
} from './data.js';
import { VIEW_INDEX, DRILL_HIERARCHIES } from './catalog.js';
import { linearForecast, anomalies, decomposeVariance, narrative, recommendationCards } from './insights.js';
import { lineChart, barChartH, waterfall, heatmap, statTile, dataTable, seriesColor } from './charts.js';

// ---------------------------------------------------------------------------
// Dashboard studio: builds and renders the standard page anatomy (§3.1) —
// A context bar · B KPI row · C trend & forecast · D driver/mix ·
// E AI insight & exceptions · F operational evidence · G governance footer —
// with hierarchy-restricted drill-down (§4.1) and role-driven masking.
// ---------------------------------------------------------------------------

const fmtM = (v) => formatMoney(v);
const fmtPct = (v) => `${v.toFixed(1)}%`;
const fmtDays = (v) => `${formatNumber(v, 1)} days`;

const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0);

function monthlyTotals(rows, f, filter = () => true) {
  return MONTHS.map((m) => sum(rows.filter((r) => r.period.key === m.key && filter(r)), f));
}

function freshnessFor(domain) {
  const rows = dataFreshness();
  const hit = rows.find((r) => r.domain.toUpperCase().startsWith(domain)) || rows[0];
  return hit;
}

// ---------- Intent builders ----------
// Each returns the full dashboard model for a given scope + drill state.

const BUILDERS = {

  'fin-exec': ({ scope, drill, role }) => {
    const rows = gl().filter((r) => !scope.company || r.company === scope.company);
    const rev = (r) => (r.accountClass === 'Revenue' ? r.actual : 0);
    const cost = (r) => (r.accountClass !== 'Revenue' ? r.actual : 0);
    const revTrend = monthlyTotals(rows, rev);
    const costTrend = monthlyTotals(rows, cost);
    const marginTrend = revTrend.map((v, i) => v - costTrend[i]);
    const budgetRev = monthlyTotals(rows, (r) => (r.accountClass === 'Revenue' ? r.budget : 0));
    const last = MONTHS.length - 1;
    const cash = cashDaily().filter((r) => !scope.company || r.company === scope.company);
    const latestCash = sum(cash.filter((c) => c.date.toDateString() === cash[cash.length - 1].date.toDateString()), (c) => c.closing);

    // Drill: company → cost centre → natural account → journal evidence.
    const levels = ['company', 'costCentre', 'accountName'];
    const path = drill.path; // e.g. [{level:'company', value:'InnovatIA Nigeria'}]
    const levelIdx = path.length;
    const drillRows = rows.filter((r) => r.period.key === MONTHS[last].key && r.accountClass !== 'Revenue'
      && path.every((p) => r[p.level] === p.value));
    const currentLevel = levels[Math.min(levelIdx, levels.length - 1)];
    const atLeaf = levelIdx >= levels.length;

    const dec = decomposeVariance(
      drillRows.map((r) => ({ key: r[currentLevel], actual: r.actual, comparative: r.budget })), { topN: 8 });

    const fresh = freshnessFor('FIN');
    const insightDec = decomposeVariance(
      rows.filter((r) => r.period.key === MONTHS[last].key && r.accountClass !== 'Revenue')
        .map((r) => ({ key: `${r.company} · ${r.costCentre}`, actual: r.actual, comparative: r.budget })));
    const story = narrative({
      metric: 'Operating cost', scopeLabel: 'plan', periodLabel: MONTHS[last].periodName,
      decomposition: insightDec, freshnessPct: fresh.quality, fmt: fmtM,
      drillHint: 'Review post-cut-off journals and recurring supplier invoices.', upIsGood: false
    });

    const fc = linearForecast(revTrend.slice(-12), 4);
    const labels = MONTHS.map((m) => m.label).concat(fc.points.map((_, i) => `F+${i + 1}`));
    const pad = (a) => a.concat(Array(fc.points.length).fill(null));

    const detailRows = atLeaf
      ? journalLines({ company: path[0]?.value, costCentre: path[1]?.value, accountName: path[2]?.value, period: MONTHS[last] })
      : drillRows.map((r) => ({
        level: r[currentLevel], period: r.period.periodName,
        actual: r.actual, budget: r.budget, variance: r.variance
      }));

    return {
      title: 'Finance Executive Overview', domain: 'FIN',
      view: 'RPT_FIN_GL_BALANCE_PERIOD_V', drillHierarchy: 'account',
      kpis: [
        { label: 'Revenue (YTD)', value: fmtM(revTrend.slice(-6).reduce((a, b) => a + b, 0)), delta: (revTrend[last] / revTrend[last - 1] - 1) * 100, upIsGood: true, trend: revTrend.slice(-12) },
        { label: 'Operating cost', value: fmtM(costTrend[last]), delta: (costTrend[last] / costTrend[last - 1] - 1) * 100, upIsGood: false, trend: costTrend.slice(-12) },
        { label: 'Gross margin', value: fmtM(marginTrend[last]), delta: (marginTrend[last] / marginTrend[last - 1] - 1) * 100, upIsGood: true, trend: marginTrend.slice(-12) },
        { label: 'Margin %', value: fmtPct(marginTrend[last] / revTrend[last] * 100), delta: null, trend: marginTrend.map((v, i) => v / revTrend[i] * 100).slice(-12) },
        { label: 'Cash balance', value: fmtM(latestCash), delta: null, status: { level: 'good', icon: '●', text: 'above threshold' } }
      ],
      trend: {
        title: 'Revenue vs budget, with forecast',
        labels,
        forecastFrom: MONTHS.length - 1,
        fmt: fmtM,
        series: [
          { name: 'Actual revenue', values: pad(revTrend).map((v, i) => i === MONTHS.length - 1 ? revTrend[last] : v).concat().slice(0, labels.length), color: seriesColor(0) },
          { name: 'Budget', values: pad(budgetRev), color: seriesColor(2), isTarget: true },
          { name: 'Forecast', values: Array(MONTHS.length - 1).fill(null).concat([revTrend[last]], fc.points), color: seriesColor(0), isTarget: true, band: Array(MONTHS.length).fill(null).concat(fc.band) }
        ]
      },
      driver: {
        title: atLeaf ? `Journal evidence — ${path.map((p) => p.value).join(' → ')}`
          : `Cost vs budget by ${{ company: 'company', costCentre: 'cost centre', accountName: 'natural account' }[currentLevel]} — ${MONTHS[last].periodName}`,
        kind: atLeaf ? 'none' : 'bar',
        items: dec.drivers.map((d, i) => ({ label: d.key, value: d.variance, extra: `Actual ${fmtM(d.actual)} · Budget ${fmtM(d.comparative)}`, color: d.variance > 0 ? seriesColor(5) : seriesColor(0) })),
        fmt: fmtM,
        drillable: !atLeaf,
        drillLevel: currentLevel
      },
      secondary: {
        title: `Variance bridge — plan to actual (${MONTHS[last].periodName})`,
        kind: 'waterfall',
        steps: [
          { label: 'Budget', value: insightDec.totalComparative, type: 'start' },
          ...insightDec.drivers.slice(0, 4).map((d) => ({ label: d.key.split(' · ')[1] || d.key, value: d.variance, type: d.variance >= 0 ? 'inc' : 'dec' })),
          { label: 'Other', value: insightDec.totalVariance - insightDec.drivers.slice(0, 4).reduce((a, d) => a + d.variance, 0), type: 'inc' },
          { label: 'Actual', value: 0, type: 'total' }
        ],
        fmt: fmtM
      },
      insight: { story, cards: recommendationCards({ drivers: insightDec.drivers, fmt: fmtM, domain: 'FIN' }) },
      detail: atLeaf ? {
        title: 'Journal lines (secure drill-through)',
        columns: [
          { key: 'journal', label: 'Journal' }, { key: 'line', label: 'Line', numeric: true },
          { key: 'date', label: 'Date' }, { key: 'source', label: 'Source' },
          { key: 'preparer', label: 'Preparer' },
          { key: 'debit', label: 'Debit', numeric: true, get: (r) => r.debit ? fmtM(r.debit) : '' },
          { key: 'credit', label: 'Credit', numeric: true, get: (r) => r.credit ? fmtM(r.credit) : '' },
          { key: 'status', label: 'Status', signal: (r) => r.status !== 'Posted' ? 'signal-warn' : '' },
          { key: 'reference', label: 'Reference' }
        ],
        rows: detailRows
      } : {
        title: `Operational evidence — ${MONTHS[last].periodName}`,
        columns: [
          { key: 'level', label: { company: 'Company', costCentre: 'Cost centre', accountName: 'Natural account' }[currentLevel] },
          { key: 'actual', label: 'Actual', numeric: true, get: (r) => fmtM(r.actual) },
          { key: 'budget', label: 'Budget', numeric: true, get: (r) => fmtM(r.budget) },
          { key: 'variance', label: 'Variance', numeric: true, get: (r) => fmtM(r.variance), signal: (r) => r.variance > 0 ? 'signal-warn' : '' }
        ],
        rows: detailRows.sort((a, b) => b.variance - a.variance)
      },
      drillLevels: levels
    };
  },

  'fin-expense-variance': (ctx) => {
    const model = BUILDERS['fin-exec'](ctx);
    model.title = 'Expense Variance Analysis';
    model.view = 'RPT_FIN_BUDGET_VS_ACTUAL_V';
    return model;
  },

  'fin-ap': ({ drill }) => {
    const ageing = apAgeing();
    const supplierIdx = new Map();
    for (const r of ageing) {
      const e = supplierIdx.get(r.supplier) || { supplier: r.supplier, category: r.category, total: 0, overdue: 0 };
      e.total += r.outstanding;
      if (r.overdue) e.overdue += r.outstanding;
      supplierIdx.set(r.supplier, e);
    }
    const suppliers = [...supplierIdx.values()].sort((a, b) => b.overdue - a.overdue);
    const selected = drill.path[0]?.value || null;
    const buckets = ['Current', '1-30 days', '31-60 days', '61-90 days', '90+ days'];
    const fresh = freshnessFor('FIN');
    const dec = decomposeVariance(suppliers.map((s) => ({ key: s.supplier, actual: s.overdue, comparative: 0 })));
    const story = narrative({
      metric: 'Overdue payables', scopeLabel: 'agreed payment terms', periodLabel: 'the current reporting date',
      decomposition: dec, freshnessPct: fresh.quality, fmt: fmtM,
      drillHint: 'Drill supplier → PO → invoice → payment for the top exposures.', upIsGood: false
    });
    const total = sum(suppliers, (s) => s.total);
    const overdue = sum(suppliers, (s) => s.overdue);
    return {
      title: 'Payables & Supplier Exposure', domain: 'FIN',
      view: 'RPT_FIN_AP_AGEING_V', drillHierarchy: 'supplier',
      kpis: [
        { label: 'Outstanding AP', value: fmtM(total) },
        { label: 'Overdue balance', value: fmtM(overdue), status: { level: overdue / total > 0.4 ? 'serious' : 'warning', icon: '▲', text: `${(overdue / total * 100).toFixed(0)}% of AP` } },
        { label: '90+ days', value: fmtM(sum(ageing.filter((r) => r.bucket === '90+ days'), (r) => r.outstanding)) },
        { label: 'Suppliers overdue', value: formatNumber(suppliers.filter((s) => s.overdue > 0).length) }
      ],
      trend: null,
      driver: {
        title: 'Overdue payables by supplier (ranked)',
        kind: 'bar',
        items: suppliers.slice(0, 8).map((s) => ({ label: s.supplier, value: s.overdue, extra: s.category })),
        fmt: fmtM, drillable: true, drillLevel: 'supplier'
      },
      secondary: {
        title: 'Ageing profile by supplier',
        kind: 'heatmap',
        rows: suppliers.slice(0, 8).map((s) => s.supplier),
        cols: buckets,
        get: (r, c) => ageing.find((a) => a.supplier === r && a.bucket === c)?.outstanding ?? 0,
        fmt: fmtM
      },
      insight: { story, cards: recommendationCards({ drivers: dec.drivers, fmt: fmtM, domain: 'FIN' }) },
      detail: {
        title: selected ? `Invoices beyond terms — ${selected}` : 'Invoices beyond agreed terms (all suppliers)',
        columns: [
          { key: 'invoice', label: 'Invoice' }, { key: 'po', label: 'PO' }, { key: 'supplier', label: 'Supplier' },
          { key: 'amount', label: 'Amount', numeric: true, get: (r) => fmtM(r.amount) },
          { key: 'dueDate', label: 'Due date' },
          { key: 'overdueDays', label: 'Days overdue', numeric: true, signal: (r) => r.overdueDays > 60 ? 'signal-bad' : r.overdueDays > 0 ? 'signal-warn' : '' },
          { key: 'status', label: 'Status' }, { key: 'hold', label: 'Hold' }
        ],
        rows: (selected ? apInvoices(selected) : suppliers.slice(0, 3).flatMap((s) => apInvoices(s.supplier))).filter((r) => r.overdueDays > 0)
      },
      drillLevels: ['supplier']
    };
  },

  'fin-cash': ({ scope }) => {
    const rows = cashDaily().filter((r) => !scope.company || r.company === scope.company);
    const byDay = new Map();
    for (const r of rows) {
      const k = r.date.toISOString().slice(0, 10);
      byDay.set(k, (byDay.get(k) || 0) + r.closing);
    }
    const days = [...byDay.keys()].sort();
    const series = days.map((d) => byDay.get(d));
    const fc = linearForecast(series.slice(-30), 30);
    const labels = days.map((d) => d.slice(5)).concat(fc.points.map((_, i) => `+${i + 1}d`));
    const threshold = series[series.length - 1] * 0.75;
    const fresh = freshnessFor('FIN');
    const byBank = new Map();
    for (const r of rows.filter((r) => r.date.toISOString().slice(0, 10) === days[days.length - 1])) {
      byBank.set(r.bank, (byBank.get(r.bank) || 0) + r.closing);
    }
    const dec = decomposeVariance([...byBank].map(([k, v]) => ({ key: k, actual: v, comparative: 0 })));
    const story = narrative({
      metric: 'Cash position', scopeLabel: 'the prior 30-day average', periodLabel: 'today',
      decomposition: dec, freshnessPct: fresh.quality, fmt: fmtM,
      drillHint: 'Drill bank → statement → transaction for balances below threshold.', upIsGood: true
    });
    const belowRisk = fc.band.filter((b) => b[0] < threshold).length;
    return {
      title: 'Daily Cash Position & 30-Day Forecast', domain: 'FIN',
      view: 'RPT_FIN_CASH_DAILY_POSITION_V', drillHierarchy: 'org',
      kpis: [
        { label: 'Closing cash (today)', value: fmtM(series[series.length - 1]), trend: series.slice(-12) },
        { label: '30-day forecast (end)', value: fmtM(fc.points[fc.points.length - 1]) },
        { label: 'Approved threshold', value: fmtM(threshold) },
        { label: 'Days at risk (fcst)', value: formatNumber(belowRisk), status: belowRisk ? { level: 'warning', icon: '▲', text: 'below threshold possible' } : { level: 'good', icon: '●', text: 'no breach projected' } }
      ],
      trend: {
        title: 'Daily closing cash with 30-day forecast and confidence band',
        labels, forecastFrom: days.length - 1, fmt: fmtM,
        series: [
          { name: 'Closing cash', values: series.concat(Array(fc.points.length).fill(null)), color: seriesColor(0) },
          { name: 'Forecast', values: Array(days.length - 1).fill(null).concat([series[series.length - 1]], fc.points), color: seriesColor(1), band: Array(days.length).fill(null).concat(fc.band) }
        ]
      },
      driver: {
        title: 'Closing balance by bank (today)',
        kind: 'bar',
        items: [...byBank].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: v })),
        fmt: fmtM, drillable: false
      },
      secondary: null,
      insight: { story, cards: recommendationCards({ drivers: dec.drivers, fmt: fmtM, domain: 'FIN' }) },
      detail: {
        title: 'Bank account positions (today)',
        columns: [
          { key: 'bank', label: 'Bank' }, { key: 'company', label: 'Company' },
          { key: 'closing', label: 'Closing', numeric: true, get: (r) => fmtM(r.closing) },
          { key: 'inflow', label: 'Inflow', numeric: true, get: (r) => fmtM(r.inflow) },
          { key: 'outflow', label: 'Outflow', numeric: true, get: (r) => fmtM(r.outflow) }
        ],
        rows: rows.filter((r) => r.date.toISOString().slice(0, 10) === days[days.length - 1])
      },
      drillLevels: []
    };
  },

  'hcm-workforce': ({ scope, drill }) => {
    const rows = workforce().filter((r) => !scope.company || r.company === scope.company);
    const last = MONTHS[MONTHS.length - 1];
    const cur = rows.filter((r) => r.period.key === last.key);
    const hcTrend = monthlyTotals(rows, (r) => r.headcount);
    const selectedDept = drill.path[0]?.value || null;
    const fresh = freshnessFor('HCM');
    const byDept = new Map();
    for (const r of cur) {
      const e = byDept.get(r.department) || { dept: r.department, headcount: 0, fte: 0, vacancies: 0, joiners: 0, leavers: 0 };
      e.headcount += r.headcount; e.fte += r.fte; e.vacancies += r.vacancies; e.joiners += r.joiners; e.leavers += r.leavers;
      byDept.set(r.department, e);
    }
    const depts = [...byDept.values()].sort((a, b) => b.headcount - a.headcount);
    const prev = rows.filter((r) => r.period.key === MONTHS[MONTHS.length - 2].key);
    const dec = decomposeVariance(cur.map((r) => ({ key: r.department, actual: r.headcount, comparative: 0 }))
      .concat(prev.map((r) => ({ key: r.department, actual: 0, comparative: r.headcount }))));
    const story = narrative({
      metric: 'Headcount', scopeLabel: 'last month', periodLabel: last.periodName,
      decomposition: dec, freshnessPct: fresh.quality, fmt: (v) => formatNumber(v),
      drillHint: 'Worker-level drill is available only to authorised HR roles.', upIsGood: true
    });
    return {
      title: 'Workforce Executive Overview', domain: 'HCM',
      view: 'RPT_HCM_WORKFORCE_SNAPSHOT_V', drillHierarchy: 'workforce',
      kpis: [
        { label: 'Headcount', value: formatNumber(sum(cur, (r) => r.headcount)), delta: (hcTrend[hcTrend.length - 1] / hcTrend[hcTrend.length - 2] - 1) * 100, upIsGood: true, trend: hcTrend.slice(-12) },
        { label: 'FTE', value: formatNumber(sum(cur, (r) => r.fte)) },
        { label: 'Joiners (month)', value: formatNumber(sum(cur, (r) => r.joiners)) },
        { label: 'Leavers (month)', value: formatNumber(sum(cur, (r) => r.leavers)) },
        { label: 'Vacancy rate', value: fmtPct(sum(cur, (r) => r.vacancies) / Math.max(1, sum(cur, (r) => r.headcount)) * 100) }
      ],
      trend: {
        title: 'Headcount trend (last 24 periods)',
        labels: MONTHS.map((m) => m.label), fmt: (v) => formatNumber(v),
        series: [{ name: 'Headcount', values: hcTrend, color: seriesColor(1) }]
      },
      driver: {
        title: 'Headcount by department', kind: 'bar',
        items: depts.map((d) => ({ label: d.dept, value: d.headcount, extra: `FTE ${formatNumber(d.fte)} · vacancies ${d.vacancies}` })),
        fmt: (v) => formatNumber(v), drillable: true, drillLevel: 'department'
      },
      secondary: {
        title: 'Absence rate by company and department (%)', kind: 'heatmap',
        rows: [...new Set(cur.map((r) => r.department))],
        cols: [...new Set(cur.map((r) => r.company))],
        get: (dept, co) => {
          const hit = cur.filter((r) => r.department === dept && r.company === co);
          return hit.length ? Math.round(hit.reduce((a, r) => a + r.absenceRate, 0) / hit.length * 10) / 10 : null;
        },
        fmt: (v) => `${v}%`
      },
      insight: { story, cards: recommendationCards({ drivers: dec.drivers, fmt: (v) => formatNumber(v), domain: 'HCM' }) },
      detail: {
        title: selectedDept ? `Department detail — ${selectedDept}` : 'Department detail',
        columns: [
          { key: 'company', label: 'Legal employer' }, { key: 'department', label: 'Department' },
          { key: 'headcount', label: 'Headcount', numeric: true },
          { key: 'fte', label: 'FTE', numeric: true },
          { key: 'joiners', label: 'Joiners', numeric: true }, { key: 'leavers', label: 'Leavers', numeric: true },
          { key: 'vacancies', label: 'Vacancies', numeric: true, signal: (r) => r.vacancies > 4 ? 'signal-warn' : '' },
          { key: 'absenceRate', label: 'Absence %', numeric: true, get: (r) => `${r.absenceRate}%` }
        ],
        rows: cur.filter((r) => !selectedDept || r.department === selectedDept)
      },
      drillLevels: ['department']
    };
  },

  'hcm-payroll': ({ scope, drill, role }) => {
    const masked = !role.canSeeSecure;
    const rows = workforce().filter((r) => !scope.company || r.company === scope.company);
    const last = MONTHS[MONTHS.length - 1];
    const cur = rows.filter((r) => r.period.key === last.key);
    const prevRows = rows.filter((r) => r.period.key === MONTHS[MONTHS.length - 2].key);
    const costTrend = monthlyTotals(rows, (r) => r.payrollCost);
    const groupKey = masked ? 'company' : 'department';
    const dec = decomposeVariance(cur.map((r) => ({ key: r[groupKey], actual: r.payrollCost, comparative: 0 }))
      .concat(prevRows.map((r) => ({ key: r[groupKey], actual: 0, comparative: r.payrollCost }))));
    const fresh = freshnessFor('HCM');
    const story = narrative({
      metric: 'Payroll cost', scopeLabel: 'last month', periodLabel: last.periodName,
      decomposition: dec, freshnessPct: fresh.quality, fmt: fmtM,
      drillHint: masked ? 'Employee-level remuneration is not displayed for your role (policy).' : 'Grade-level drill available; employee remuneration remains masked by policy.',
      upIsGood: false
    });
    return {
      title: 'People Cost Analysis (Secure)', domain: 'HCM',
      view: 'SEC_HCM_PAYROLL_COST_V', drillHierarchy: 'workforce',
      maskedBanner: masked ? 'SEC_HCM_PAYROLL_COST_V is a secure view: results are aggregated to company level and sensitive fields are masked for your role.' : null,
      kpis: [
        { label: 'Payroll cost (month)', value: fmtM(costTrend[costTrend.length - 1]), delta: (costTrend[costTrend.length - 1] / costTrend[costTrend.length - 2] - 1) * 100, upIsGood: false, trend: costTrend.slice(-12) },
        { label: 'Cost per FTE', value: fmtM(sum(cur, (r) => r.payrollCost) / Math.max(1, sum(cur, (r) => r.fte))) },
        { label: 'FTE', value: formatNumber(sum(cur, (r) => r.fte)) },
        { label: 'MoM movement', value: fmtM(dec.totalVariance) }
      ],
      trend: {
        title: 'Payroll cost trend', labels: MONTHS.map((m) => m.label), fmt: fmtM,
        series: [{ name: 'Payroll cost', values: costTrend, color: seriesColor(1) }]
      },
      driver: {
        title: `Cost movement by ${masked ? 'company (masked scope)' : 'department'} — MoM`, kind: 'bar',
        items: dec.drivers.map((d) => ({ label: d.key, value: d.variance, color: d.variance > 0 ? seriesColor(5) : seriesColor(0) })),
        fmt: fmtM, drillable: false
      },
      secondary: null,
      insight: { story, cards: recommendationCards({ drivers: dec.drivers, fmt: fmtM, domain: 'HCM' }) },
      detail: {
        title: masked ? 'Aggregated people-cost detail (masked)' : 'People-cost detail by department',
        columns: [
          { key: 'k', label: masked ? 'Company' : 'Department' },
          { key: 'cost', label: 'Payroll cost', numeric: true, get: (r) => fmtM(r.cost) },
          { key: 'fte', label: 'FTE', numeric: true, get: (r) => formatNumber(r.fte) },
          { key: 'cpf', label: 'Cost per FTE', numeric: true, get: (r) => fmtM(r.cost / Math.max(1, r.fte)) }
        ],
        rows: [...cur.reduce((m, r) => {
          const k = r[groupKey];
          const e = m.get(k) || { k, cost: 0, fte: 0 };
          e.cost += r.payrollCost; e.fte += r.fte;
          return m.set(k, e);
        }, new Map()).values()].sort((a, b) => b.cost - a.cost)
      },
      drillLevels: []
    };
  },

  'hcm-absence': (ctx) => {
    const model = BUILDERS['hcm-workforce'](ctx);
    model.title = 'Absence & Workforce Availability';
    model.view = 'RPT_HCM_ABSENCE_ACCRUAL_V';
    return model;
  },

  'scm-spend': ({ scope, drill }) => {
    const rows = spend().filter((r) => !scope.company || r.company === scope.company);
    const yearRows = rows.filter((r) => r.period.year === MONTHS[MONTHS.length - 1].year);
    const byCat = new Map();
    for (const r of yearRows) byCat.set(r.category, (byCat.get(r.category) || 0) + r.spend);
    const bySup = new Map();
    for (const r of yearRows) bySup.set(r.supplier, (bySup.get(r.supplier) || 0) + r.spend);
    const totalSpend = sum(yearRows, (r) => r.spend);
    const suppliers = [...bySup].sort((a, b) => b[1] - a[1]);
    const top3Share = suppliers.slice(0, 3).reduce((a, s) => a + s[1], 0) / totalSpend * 100;
    const selectedCat = drill.path[0]?.value || null;
    const spendTrend = monthlyTotals(rows, (r) => r.spend);
    const fresh = freshnessFor('SCM');
    const dec = decomposeVariance(suppliers.map(([k, v]) => ({ key: k, actual: v, comparative: 0 })));
    const story = narrative({
      metric: 'Procurement spend concentration', scopeLabel: 'the diversification target', periodLabel: `FY${MONTHS[MONTHS.length - 1].year}`,
      decomposition: dec, freshnessPct: fresh.quality, fmt: fmtM,
      drillHint: 'Drill category → supplier → PO → receipt → invoice for contract compliance.', upIsGood: false
    });
    return {
      title: 'Procurement Spend Analysis', domain: 'SCM',
      view: 'RPT_SCM_SPEND_ANALYSIS_V', drillHierarchy: 'supplier',
      kpis: [
        { label: 'Spend (year)', value: fmtM(totalSpend), trend: spendTrend.slice(-12) },
        { label: 'Top-3 supplier share', value: fmtPct(top3Share), status: top3Share > 45 ? { level: 'warning', icon: '▲', text: 'concentration risk' } : { level: 'good', icon: '●', text: 'diversified' } },
        { label: 'Active suppliers', value: formatNumber(bySup.size) },
        { label: 'Categories', value: formatNumber(byCat.size) }
      ],
      trend: {
        title: 'Monthly spend trend', labels: MONTHS.map((m) => m.label), fmt: fmtM,
        series: [{ name: 'Spend', values: spendTrend, color: seriesColor(2) }]
      },
      driver: {
        title: selectedCat ? `Spend by supplier — ${selectedCat}` : 'Spend by category (drill to supplier)',
        kind: 'bar',
        items: selectedCat
          ? [...yearRows.filter((r) => r.category === selectedCat).reduce((m, r) => m.set(r.supplier, (m.get(r.supplier) || 0) + r.spend), new Map())].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: v }))
          : [...byCat].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: v })),
        fmt: fmtM, drillable: !selectedCat, drillLevel: 'category'
      },
      secondary: {
        title: 'Supplier concentration (share of total spend %)', kind: 'bar2',
        items: suppliers.slice(0, 6).map(([k, v]) => ({ label: k, value: v / totalSpend * 100 })),
        fmt: fmtPct
      },
      insight: { story, cards: recommendationCards({ drivers: dec.drivers, fmt: fmtM, domain: 'SCM' }) },
      detail: {
        title: 'Supplier detail (drill to PO → receipt → invoice)',
        columns: [
          { key: 'supplier', label: 'Supplier' }, { key: 'category', label: 'Category' },
          { key: 'spend', label: 'Spend', numeric: true, get: (r) => fmtM(r.spend) },
          { key: 'onTimeDelivery', label: 'OTD %', numeric: true, get: (r) => fmtPct(r.onTimeDelivery), signal: (r) => r.onTimeDelivery < 85 ? 'signal-warn' : '' },
          { key: 'leadTime', label: 'Lead time', numeric: true, get: (r) => fmtDays(r.leadTime) },
          { key: 'exceptions', label: 'Match exceptions', numeric: true, signal: (r) => r.exceptions > 2 ? 'signal-bad' : '' }
        ],
        rows: [...yearRows.filter((r) => !selectedCat || r.category === selectedCat)
          .reduce((m, r) => {
            const e = m.get(r.supplier) || { supplier: r.supplier, category: r.category, spend: 0, onTimeDelivery: 0, leadTime: 0, exceptions: 0, n: 0 };
            e.spend += r.spend; e.onTimeDelivery += r.onTimeDelivery; e.leadTime += r.leadTime; e.exceptions += r.exceptions; e.n++;
            return m.set(r.supplier, e);
          }, new Map()).values()].map((e) => ({ ...e, onTimeDelivery: e.onTimeDelivery / e.n, leadTime: e.leadTime / e.n })).sort((a, b) => b.spend - a.spend)
      },
      drillLevels: ['category']
    };
  },

  'scm-stockout': ({ drill }) => {
    const rows = inventory();
    const atRisk = rows.filter((r) => r.stockoutRisk !== 'Low');
    const selectedCat = drill.path[0]?.value || null;
    const fresh = freshnessFor('SCM');
    const dec = decomposeVariance(atRisk.map((r) => ({ key: r.item + ' ' + r.description, actual: r.value, comparative: 0 })));
    const story = narrative({
      metric: 'Inventory value at stockout risk', scopeLabel: 'the coverage policy', periodLabel: 'the next 30 days',
      decomposition: dec, freshnessPct: fresh.quality, fmt: fmtM,
      drillHint: 'Drill category → item → supply/demand signals; review replenishment for high-risk items.', upIsGood: false
    });
    const byCat = new Map();
    for (const r of rows) {
      const e = byCat.get(r.category) || { cat: r.category, value: 0, risk: 0 };
      e.value += r.value; if (r.stockoutRisk === 'High') e.risk += r.value;
      byCat.set(r.category, e);
    }
    return {
      title: 'Inventory Availability & Stockout Risk', domain: 'SCM',
      view: 'RPT_SCM_STOCKOUT_RISK_V', drillHierarchy: 'item',
      kpis: [
        { label: 'Inventory value', value: fmtM(sum(rows, (r) => r.value)) },
        { label: 'Items at risk (30d)', value: formatNumber(atRisk.filter((r) => r.stockoutRisk === 'High').length), status: { level: 'serious', icon: '▲', text: 'high stockout risk' } },
        { label: 'Value at risk', value: fmtM(sum(atRisk.filter((r) => r.stockoutRisk === 'High'), (r) => r.value)) },
        { label: 'Slow/non-moving', value: fmtM(sum(rows.filter((r) => r.velocity !== 'Fast'), (r) => r.value)) }
      ],
      trend: null,
      driver: {
        title: 'Value at risk by category', kind: 'bar',
        items: [...byCat.values()].sort((a, b) => b.risk - a.risk).map((e) => ({ label: e.cat, value: e.risk, extra: `Total value ${fmtM(e.value)}` })),
        fmt: fmtM, drillable: true, drillLevel: 'category'
      },
      secondary: {
        title: 'Days of supply by item and org', kind: 'heatmap',
        rows: [...new Set(rows.map((r) => r.item))].slice(0, 8),
        cols: [...new Set(rows.map((r) => r.org))],
        get: (item, org) => rows.find((r) => r.item === item && r.org === org)?.daysOfSupply ?? null,
        fmt: (v) => `${v} days of supply`
      },
      insight: { story, cards: recommendationCards({ drivers: dec.drivers, fmt: fmtM, domain: 'SCM' }) },
      detail: {
        title: 'Item risk detail (drill to supply/demand signals)',
        columns: [
          { key: 'item', label: 'Item' }, { key: 'description', label: 'Description' },
          { key: 'org', label: 'Inventory org' }, { key: 'businessUnit', label: 'Business unit' },
          { key: 'onHand', label: 'On hand', numeric: true, get: (r) => formatNumber(r.onHand) },
          { key: 'daysOfSupply', label: 'Days of supply', numeric: true, signal: (r) => r.daysOfSupply < 7 ? 'signal-bad' : r.daysOfSupply < 14 ? 'signal-warn' : '' },
          { key: 'stockoutRisk', label: 'Risk' }, { key: 'velocity', label: 'Velocity' }
        ],
        rows: rows.filter((r) => !selectedCat || r.category === selectedCat).sort((a, b) => a.daysOfSupply - b.daysOfSupply)
      },
      drillLevels: ['category']
    };
  },

  'cx-pipeline': ({ scope, drill }) => {
    const rows = pipeline().filter((r) => !scope.company || r.company === scope.company);
    const stages = ENTERPRISE.salesStages;
    const byStage = stages.map((s) => ({ stage: s, amount: sum(rows.filter((r) => r.stage === s), (r) => r.amount), weighted: sum(rows.filter((r) => r.stage === s), (r) => r.weighted) }));
    const selectedOwner = drill.path[0]?.value || null;
    const fresh = freshnessFor('CX');
    const atRisk = rows.filter((r) => r.atRisk);
    const dec = decomposeVariance(atRisk.map((r) => ({ key: r.owner, actual: r.amount, comparative: 0 })));
    const story = narrative({
      metric: 'Pipeline value at risk', scopeLabel: 'the healthy-pipeline baseline', periodLabel: 'the current snapshot',
      decomposition: dec, freshnessPct: fresh.quality, fmt: fmtM,
      drillHint: 'Drill owner → opportunity; prioritise stale deals with close dates in the past.', upIsGood: false
    });
    const byOwner = new Map();
    for (const r of rows) {
      const e = byOwner.get(r.owner) || { owner: r.owner, amount: 0, weighted: 0, deals: 0, risk: 0 };
      e.amount += r.amount; e.weighted += r.weighted; e.deals++; if (r.atRisk) e.risk += r.amount;
      byOwner.set(r.owner, e);
    }
    return {
      title: 'Sales Pipeline Command Centre', domain: 'CX',
      view: 'RPT_CX_OPPORTUNITY_PIPELINE_SNAPSHOT_V', drillHierarchy: 'customer',
      kpis: [
        { label: 'Pipeline', value: fmtM(sum(rows, (r) => r.amount)) },
        { label: 'Weighted pipeline', value: fmtM(sum(rows, (r) => r.weighted)) },
        { label: 'Open deals', value: formatNumber(rows.length) },
        { label: 'Value at risk', value: fmtM(sum(atRisk, (r) => r.amount)), status: { level: 'warning', icon: '▲', text: `${atRisk.length} stale/overdue deals` } }
      ],
      trend: null,
      driver: {
        title: 'Pipeline by stage (funnel)', kind: 'bar',
        items: byStage.map((s, i) => ({ label: s.stage, value: s.amount, extra: `Weighted ${fmtM(s.weighted)}` })),
        fmt: fmtM, drillable: false, keepOrder: true
      },
      secondary: {
        title: 'Weighted pipeline by sales owner', kind: 'bar2',
        items: [...byOwner.values()].sort((a, b) => b.weighted - a.weighted).map((o) => ({ label: o.owner, value: o.weighted, extra: `${o.deals} deals · at risk ${fmtM(o.risk)}` })),
        fmt: fmtM, drillable: true, drillLevel: 'owner'
      },
      insight: { story, cards: recommendationCards({ drivers: dec.drivers, fmt: fmtM, domain: 'CX' }) },
      detail: {
        title: selectedOwner ? `Opportunities — ${selectedOwner}` : 'Top opportunities (drill from owner ranking)',
        columns: [
          { key: 'opportunity', label: 'Opportunity' }, { key: 'customer', label: 'Customer' },
          { key: 'owner', label: 'Owner' }, { key: 'stage', label: 'Stage' },
          { key: 'amount', label: 'Amount', numeric: true, get: (r) => fmtM(r.amount) },
          { key: 'probability', label: 'Prob %', numeric: true },
          { key: 'closeDate', label: 'Close date' },
          { key: 'daysSinceActivity', label: 'Days inactive', numeric: true, signal: (r) => r.daysSinceActivity > 21 ? 'signal-bad' : '' }
        ],
        rows: rows.filter((r) => !selectedOwner || r.owner === selectedOwner).sort((a, b) => b.amount - a.amount)
      },
      drillLevels: ['owner']
    };
  },

  'cx-forecast': (ctx) => {
    const model = BUILDERS['cx-pipeline'](ctx);
    model.title = 'Forecast Accuracy & Sales Performance';
    model.view = 'RPT_CX_FORECAST_ACCURACY_V';
    return model;
  },

  'xfn-ccc': ({ scope, drill }) => {
    const rows = cashConversion().filter((r) => !scope.company || r.company === scope.company);
    const last = MONTHS[MONTHS.length - 1];
    const cur = rows.filter((r) => r.period.key === last.key);
    const prev = rows.filter((r) => r.period.key === MONTHS[MONTHS.length - 2].key);
    const avg = (arr, f) => arr.length ? arr.reduce((a, r) => a + f(r), 0) / arr.length : 0;
    const cccTrend = MONTHS.map((m) => avg(rows.filter((r) => r.period.key === m.key), (r) => r.ccc));
    const dsoTrend = MONTHS.map((m) => avg(rows.filter((r) => r.period.key === m.key), (r) => r.dso));
    const dpoTrend = MONTHS.map((m) => avg(rows.filter((r) => r.period.key === m.key), (r) => r.dpo));
    const dioTrend = MONTHS.map((m) => avg(rows.filter((r) => r.period.key === m.key), (r) => r.dio));
    const fresh = freshnessFor('XFN');
    const dec = decomposeVariance([
      { key: 'Receivables (DSO)', actual: avg(cur, (r) => r.dso), comparative: avg(prev, (r) => r.dso) },
      { key: 'Inventory (DIO)', actual: avg(cur, (r) => r.dio), comparative: avg(prev, (r) => r.dio) },
      { key: 'Payables (DPO)', actual: -avg(cur, (r) => r.dpo), comparative: -avg(prev, (r) => r.dpo) }
    ]);
    const story = narrative({
      metric: 'Cash conversion cycle', scopeLabel: 'last month', periodLabel: last.periodName,
      decomposition: dec, freshnessPct: fresh.quality, fmt: (v) => `${Math.abs(v).toFixed(1)} days`,
      drillHint: 'Drill to the AR ageing, AP ageing and inventory driver pages.', upIsGood: false
    });
    return {
      title: 'Cash Conversion Cycle', domain: 'XFN',
      view: 'RPT_XFN_CASH_CONVERSION_CYCLE_V', drillHierarchy: 'org',
      kpis: [
        { label: 'CCC (days)', value: formatNumber(avg(cur, (r) => r.ccc), 1), delta: (avg(cur, (r) => r.ccc) / avg(prev, (r) => r.ccc) - 1) * 100, upIsGood: false, trend: cccTrend.slice(-12) },
        { label: 'DSO', value: formatNumber(avg(cur, (r) => r.dso), 1) },
        { label: 'DPO', value: formatNumber(avg(cur, (r) => r.dpo), 1) },
        { label: 'Inventory days', value: formatNumber(avg(cur, (r) => r.dio), 1) }
      ],
      trend: {
        title: 'CCC components trend (days)', labels: MONTHS.map((m) => m.label), fmt: (v) => formatNumber(v, 0),
        series: [
          { name: 'CCC', values: cccTrend, color: seriesColor(0) },
          { name: 'DSO', values: dsoTrend, color: seriesColor(1) },
          { name: 'DPO', values: dpoTrend, color: seriesColor(2) },
          { name: 'Inventory days', values: dioTrend, color: seriesColor(4) }
        ]
      },
      driver: {
        title: `CCC by company — ${last.periodName}`, kind: 'bar',
        items: cur.sort((a, b) => b.ccc - a.ccc).map((r) => ({ label: r.company, value: r.ccc, extra: `DSO ${r.dso.toFixed(0)} · DPO ${r.dpo.toFixed(0)} · DIO ${r.dio.toFixed(0)}` })),
        fmt: (v) => `${formatNumber(v, 0)}d`, drillable: false
      },
      secondary: {
        title: 'MoM movement bridge (days)', kind: 'waterfall',
        steps: [
          { label: `CCC ${MONTHS[MONTHS.length - 2].periodName}`, value: avg(prev, (r) => r.ccc), type: 'start' },
          ...dec.drivers.map((d) => ({ label: d.key.split(' ')[0], value: d.variance, type: d.variance >= 0 ? 'inc' : 'dec' })),
          { label: `CCC ${last.periodName}`, value: 0, type: 'total' }
        ],
        fmt: (v) => `${formatNumber(v, 1)}d`
      },
      insight: { story, cards: recommendationCards({ drivers: dec.drivers, fmt: (v) => `${Math.abs(v).toFixed(1)} days`, domain: 'XFN' }) },
      detail: {
        title: 'Company detail',
        columns: [
          { key: 'company', label: 'Company' },
          { key: 'dso', label: 'DSO', numeric: true, get: (r) => formatNumber(r.dso, 1) },
          { key: 'dpo', label: 'DPO', numeric: true, get: (r) => formatNumber(r.dpo, 1) },
          { key: 'dio', label: 'Inventory days', numeric: true, get: (r) => formatNumber(r.dio, 1) },
          { key: 'ccc', label: 'CCC', numeric: true, get: (r) => formatNumber(r.ccc, 1), signal: (r) => r.ccc > 40 ? 'signal-warn' : '' }
        ],
        rows: cur
      },
      drillLevels: []
    };
  },

  'xfn-productivity': ({ scope }) => {
    const wf = workforce().filter((r) => !scope.company || r.company === scope.company);
    const rows = gl().filter((r) => !scope.company || r.company === scope.company);
    const last = MONTHS[MONTHS.length - 1];
    const byCo = new Map();
    for (const co of companies().filter((c) => !scope.company || c.name === scope.company)) {
      const rev = sum(rows.filter((r) => r.company === co.name && r.period.key === last.key && r.accountClass === 'Revenue'), (r) => r.actual);
      const cost = sum(wf.filter((r) => r.company === co.name && r.period.key === last.key), (r) => r.payrollCost);
      const fte = sum(wf.filter((r) => r.company === co.name && r.period.key === last.key), (r) => r.fte);
      byCo.set(co.name, { company: co.name, revenuePerFte: rev / Math.max(1, fte), costPerFte: cost / Math.max(1, fte), fte });
    }
    const list = [...byCo.values()];
    const fresh = freshnessFor('XFN');
    const mean = list.reduce((a, r) => a + r.revenuePerFte, 0) / list.length;
    const dec = decomposeVariance(list.map((r) => ({ key: r.company, actual: r.revenuePerFte, comparative: mean })));
    const story = narrative({
      metric: 'Revenue per FTE', scopeLabel: 'the group average', periodLabel: last.periodName,
      decomposition: dec, freshnessPct: fresh.quality, fmt: fmtM,
      drillHint: 'Outliers below the group average warrant a workforce-cost review with the department view.', upIsGood: true
    });
    return {
      title: 'Workforce Cost & Productivity', domain: 'XFN',
      view: 'RPT_XFN_WORKFORCE_COST_PRODUCTIVITY_V', drillHierarchy: 'org',
      kpis: [
        { label: 'Revenue per FTE (avg)', value: fmtM(mean) },
        { label: 'Cost per FTE (avg)', value: fmtM(list.reduce((a, r) => a + r.costPerFte, 0) / list.length) },
        { label: 'Group FTE', value: formatNumber(list.reduce((a, r) => a + r.fte, 0)) },
        { label: 'Outliers', value: formatNumber(list.filter((r) => Math.abs(r.revenuePerFte - mean) / mean > 0.25).length), status: { level: 'warning', icon: '▲', text: '>25% from group average' } }
      ],
      trend: null,
      driver: {
        title: 'Revenue per FTE by company', kind: 'bar',
        items: list.sort((a, b) => b.revenuePerFte - a.revenuePerFte).map((r) => ({ label: r.company, value: r.revenuePerFte, extra: `Cost per FTE ${fmtM(r.costPerFte)}` })),
        fmt: fmtM, drillable: false
      },
      secondary: {
        title: 'Cost per FTE by company', kind: 'bar2',
        items: list.sort((a, b) => b.costPerFte - a.costPerFte).map((r) => ({ label: r.company, value: r.costPerFte })),
        fmt: fmtM
      },
      insight: { story, cards: recommendationCards({ drivers: dec.drivers, fmt: fmtM, domain: 'XFN' }) },
      detail: {
        title: 'Company productivity detail',
        columns: [
          { key: 'company', label: 'Company' },
          { key: 'fte', label: 'FTE', numeric: true, get: (r) => formatNumber(r.fte) },
          { key: 'revenuePerFte', label: 'Revenue / FTE', numeric: true, get: (r) => fmtM(r.revenuePerFte) },
          { key: 'costPerFte', label: 'Cost / FTE', numeric: true, get: (r) => fmtM(r.costPerFte) }
        ],
        rows: list
      },
      drillLevels: []
    };
  }
};

export function buildDashboard(intentId, { scope = {}, drill = { path: [] }, role }) {
  const builder = BUILDERS[intentId] || BUILDERS['fin-exec'];
  const model = builder({ scope, drill, role });
  model.intentId = BUILDERS[intentId] ? intentId : 'fin-exec';
  model.scope = scope;
  model.drill = drill;
  return model;
}

// ---------- Renderer ----------

export function renderDashboard(container, model, { onDrill, onAsk, role }) {
  container.innerHTML = '';
  const viewMeta = VIEW_INDEX.get(model.view);
  const fresh = freshnessFor(model.domain);
  const hierarchy = DRILL_HIERARCHIES.find((h) => h.id === model.drillHierarchy);

  const page = document.createElement('div');
  page.className = 'dash-page';

  // A. Context bar
  const crumbs = model.drill.path.map((p, i) =>
    `<button class="crumb" data-depth="${i}">${p.value}</button>`).join('<span class="crumb-sep">→</span>');
  page.insertAdjacentHTML('beforeend', `
    <div class="dash-zone dash-context">
      <div class="dash-title-wrap">
        <h2>${model.title}</h2>
        <div class="dash-sub">
          <span>Period: ${model.scope.period?.label || 'Last 12 months'}</span>
          <span>Scope: ${model.scope.company || ENTERPRISE.group}</span>
          <span>Currency: ${ENTERPRISE.reportingCurrency}</span>
          <span>Last refresh: ${LAST_REFRESH.toLocaleString('en-GB')}</span>
        </div>
        ${model.drill.path.length ? `<div class="dash-crumbs"><button class="crumb" data-depth="-1">All</button><span class="crumb-sep">→</span>${crumbs}</div>` : ''}
      </div>
      <div class="dash-ask">
        <input type="text" class="ask-box" placeholder="Ask this dashboard… (explain / compare / investigate / refine)" />
      </div>
    </div>`);

  if (model.maskedBanner) {
    page.insertAdjacentHTML('beforeend', `<div class="masked-banner">🔒 ${model.maskedBanner}</div>`);
  }

  // B. KPI row
  const kpiRow = document.createElement('div');
  kpiRow.className = 'dash-zone kpi-row';
  for (const k of model.kpis.slice(0, 6)) kpiRow.appendChild(statTile(k));
  page.appendChild(kpiRow);

  // C + D. Trend and driver
  const midGrid = document.createElement('div');
  midGrid.className = 'dash-grid-2';
  if (model.trend) {
    const card = zoneCard(model.trend.title);
    midGrid.appendChild(card.wrap);
    requestAnimationFrame(() => lineChart(card.body, model.trend));
  }
  if (model.driver && model.driver.kind === 'bar') {
    const card = zoneCard(model.driver.title, model.driver.drillable ? 'Click a bar to drill' : null);
    midGrid.appendChild(card.wrap);
    requestAnimationFrame(() => barChartH(card.body, {
      items: model.driver.items, fmt: model.driver.fmt,
      onBarClick: model.driver.drillable ? (d) => onDrill(model.driver.drillLevel, d.label) : null
    }));
  }
  page.appendChild(midGrid);

  // Second visual band: secondary + AI insight
  const lowGrid = document.createElement('div');
  lowGrid.className = 'dash-grid-2';
  if (model.secondary) {
    const card = zoneCard(model.secondary.title, model.secondary.drillable ? 'Click a bar to drill' : null);
    lowGrid.appendChild(card.wrap);
    const sec = model.secondary;
    requestAnimationFrame(() => {
      if (sec.kind === 'waterfall') waterfall(card.body, sec);
      else if (sec.kind === 'heatmap') heatmap(card.body, sec);
      else barChartH(card.body, {
        items: sec.items, fmt: sec.fmt, color: seriesColor(1),
        onBarClick: sec.drillable ? (d) => onDrill(sec.drillLevel, d.label) : null
      });
    });
  }

  // E. Insight & action
  const story = model.insight.story;
  const insightCard = zoneCard('AI insight, anomaly and action');
  insightCard.body.innerHTML = `
    <div class="insight-summary insight-${story.tone}">${story.summary}</div>
    <div class="insight-confidence"><b>Confidence:</b> ${story.confidenceDetail}</div>
    <div class="insight-method"><b>Method:</b> ${story.method}</div>
    <div class="insight-steps"><b>Recommended next steps</b><ol>${story.nextSteps.map((s) => `<li>${s}</li>`).join('')}</ol></div>
    <div class="insight-cards">${model.insight.cards.map((c) => `
      <div class="rec-card"><div class="rec-title">${c.title}</div><div class="rec-body">${c.body}</div>
      <div class="rec-owner">Suggested owner: ${c.owner} · <em>advisory only — no transaction is executed</em></div></div>`).join('')}
    </div>`;
  lowGrid.appendChild(insightCard.wrap);
  page.appendChild(lowGrid);

  // F. Operational evidence
  if (model.detail) {
    const card = zoneCard(model.detail.title, hierarchy ? `Drill route: ${hierarchy.route.join(' → ')}` : null);
    card.wrap.classList.add('detail-zone');
    page.appendChild(card.wrap);
    dataTable(card.body, {
      columns: model.detail.columns,
      rows: model.detail.rows,
      onRowClick: model.drillLevels.length > model.drill.path.length && model.driver?.drillable
        ? (row) => { const key = model.detail.columns[0]; const v = typeof key.get === 'function' ? key.get(row) : row[key.key]; onDrill(model.driver.drillLevel, v); }
        : null
    });
  }

  // G. Governance footer
  page.insertAdjacentHTML('beforeend', `
    <div class="dash-zone gov-footer">
      <span><b>Source view:</b> ${model.view}</span>
      <span><b>Data owner:</b> ${viewMeta?.owner || '—'}</span>
      <span><b>Refresh:</b> ${viewMeta?.refresh || '—'} · batch ${fresh.batch} · ${fresh.status}</span>
      <span><b>Data quality:</b> ${fresh.quality.toFixed(1)}%</span>
      <span><b>Security context:</b> ${role.label}${viewMeta?.secure ? ' · row-level security & masking applied' : ''}</span>
      <span><b>Definition:</b> v1.0 · governed by ${model.domain} metric dictionary</span>
    </div>`);

  container.appendChild(page);

  // Breadcrumb + ask-box wiring
  page.querySelectorAll('.crumb').forEach((btn) => {
    btn.addEventListener('click', () => onDrill('__pop__', Number(btn.dataset.depth)));
  });
  const askBox = page.querySelector('.ask-box');
  askBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && askBox.value.trim()) onAsk(askBox.value.trim());
  });
}

function zoneCard(title, hint = null) {
  const wrap = document.createElement('div');
  wrap.className = 'dash-zone zone-card';
  wrap.innerHTML = `<div class="zone-head"><h3>${title}</h3>${hint ? `<span class="zone-hint">${hint}</span>` : ''}</div>`;
  const body = document.createElement('div');
  body.className = 'zone-body';
  wrap.appendChild(body);
  return { wrap, body };
}
