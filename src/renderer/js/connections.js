'use strict';

import { VIEWS, VIEW_INDEX, DOMAINS } from './catalog.js';
import { validateSql } from './guardrail.js';
import { allIntents } from './promptEngine.js';
import {
  dataFreshness, gl, apAgeing, arAgeing, cashDaily, workforce, spend,
  inventory, pipeline, cashConversion, MONTHS
} from './data.js';

// ---------------------------------------------------------------------------
// Connection service: ADW / OAC / AI-gateway test handshakes, the ADW
// dictionary browser (schemas → tables → columns) and table insight
// profiling that seeds dashboard creation.
//
// Demo mode simulates the handshake and dictionary against the embedded
// environment. Live mode routes through the gateway / endpoints over HTTPS
// (executed in the Electron main process — the renderer cannot make network
// calls by CSP design). Passwords are held in memory for the session only
// and are never persisted (§12.3: vault, not disk).
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Session-only secrets (never written through saveSettings).
export const sessionSecrets = { adwPassword: '', oacPassword: '', walletPath: '', walletPassword: '', aiKey: '' };

// Supported AI connectors. "gateway" is the governed enterprise route; the
// direct Claude / ChatGPT connectors are for evaluation deployments — every
// prompt still passes the SQL guardrail and audit trail regardless of provider.
export const AI_PROVIDERS = [
  {
    id: 'gateway', label: 'InnovatIA AI Gateway (governed)',
    accountLabel: 'Service account', keyLabel: 'Client secret / token',
    defaultModel: '', testPath: '/health',
    note: 'Recommended for production: prompts, metadata retrieval and model calls run behind the enterprise gateway with the approved policy pack.'
  },
  {
    id: 'claude', label: 'Claude (Anthropic)',
    accountLabel: 'Account email (username)', keyLabel: 'API key (password)',
    defaultModel: 'claude-opus-4-8', endpoint: 'https://api.anthropic.com',
    note: 'Connects to the Anthropic API. The API key is held in memory for this session only.'
  },
  {
    id: 'openai', label: 'ChatGPT (OpenAI)',
    accountLabel: 'Account email (username)', keyLabel: 'API key (password)',
    defaultModel: 'gpt-5.2', endpoint: 'https://api.openai.com',
    note: 'Connects to the OpenAI API. The API key is held in memory for this session only.'
  }
];

function require_(fields) {
  const missing = Object.entries(fields).filter(([, v]) => !String(v || '').trim()).map(([k]) => k);
  return missing.length ? `Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.` : null;
}

const writeWarning = 'Read-write access violates the platform control (§12.3): dashboard execution must use a read-only service account. Reserve read-write for the data-engineering pipeline user and the SQL Workbench engineering lane.';

export async function testAdw({ settings, bridge }) {
  const s = settings.adw;
  const err = require_({
    'service name / connect string': s.serviceName || s.host || (settings.mode === 'demo' ? 'demo' : ''),
    'wallet file': sessionSecrets.walletPath || s.walletFileName,
    username: s.username,
    password: sessionSecrets.adwPassword
  });
  if (err) return { ok: false, detail: err };

  if (settings.mode === 'demo') {
    await sleep(700);
    return {
      ok: true,
      detail: `Connected to Oracle ADW 19c — service ${s.serviceName || 'innovatia_low'} as ${s.username} `
        + `(${s.access === 'write' ? 'READ-WRITE' : 'READ-ONLY'}, mTLS wallet ${walletName(s)})`,
      latencyMs: 700,
      warning: s.access === 'write' ? writeWarning : null
    };
  }

  // Live mode connects DIRECTLY to ADW from the desktop client — no gateway.
  if (!bridge.adwTest) {
    return { ok: false, detail: 'Direct ADW connectivity is only available in the packaged desktop app (this is the browser preview).' };
  }
  const started = Date.now();
  const res = await bridge.adwTest({
    adw: { username: s.username, serviceName: s.serviceName, host: s.host, access: s.access, walletPassword: sessionSecrets.walletPassword || '' },
    walletPath: sessionSecrets.walletPath || s.walletFileName,
    password: sessionSecrets.adwPassword,
    timeoutMs: settings.gateway.timeoutS * 1000
  });
  return {
    ok: res.ok,
    detail: res.detail,
    latencyMs: Date.now() - started,
    warning: res.ok && s.access === 'write' ? writeWarning : null
  };
}

export async function testOac({ settings, bridge }) {
  const s = settings.oac;
  const err = require_({ 'OAC instance URL': settings.mode === 'demo' ? (s.url || 'demo') : s.url, username: s.username, password: sessionSecrets.oacPassword });
  if (err) return { ok: false, detail: err };
  if (settings.mode === 'demo') {
    await sleep(500);
    return {
      ok: true,
      detail: `Authenticated to OAC as ${s.username} — catalog root ${s.catalogRoot} reachable, `
        + `REST API v1 and 7 approved templates visible.`,
      latencyMs: 500
    };
  }
  const res = await bridge.httpTest({ url: `${trimSlash(s.url)}/api/20210901/system/status`, timeoutMs: settings.gateway.timeoutS * 1000 });
  return {
    ok: res.ok,
    detail: res.ok ? `OAC endpoint reachable (HTTP ${res.status}, ${res.latencyMs} ms). Credential validation completes on first publish.`
      : `OAC test failed: ${res.error || `HTTP ${res.status}`}.`,
    latencyMs: res.latencyMs
  };
}

export async function testGateway({ settings, bridge }) {
  const err = require_({ 'gateway URL': settings.gateway.url });
  if (err) return { ok: false, detail: err };
  if (settings.mode === 'demo') {
    await sleep(400);
    return { ok: true, detail: `InnovatIA AI Gateway healthy — policy pack v2026.07, SQL guardrail active, audit sink connected.`, latencyMs: 400 };
  }
  const res = await bridge.httpTest({ url: `${trimSlash(settings.gateway.url)}/health`, timeoutMs: settings.gateway.timeoutS * 1000 });
  return {
    ok: res.ok,
    detail: res.ok ? `Gateway healthy (HTTP ${res.status}, ${res.latencyMs} ms).` : `Gateway unreachable: ${res.error || `HTTP ${res.status}`}.`,
    latencyMs: res.latencyMs
  };
}

export async function testAi({ settings, bridge }) {
  const provider = AI_PROVIDERS.find((p) => p.id === settings.ai.provider) || AI_PROVIDERS[0];
  if (provider.id === 'gateway') return testGateway({ settings, bridge });

  const err = require_({ [provider.accountLabel]: settings.ai.username, [provider.keyLabel]: sessionSecrets.aiKey });
  if (err) return { ok: false, detail: err };

  if (settings.mode === 'demo') {
    await sleep(450);
    return {
      ok: true,
      detail: `Authenticated to ${provider.label} as ${settings.ai.username} — model ${settings.ai.model || provider.defaultModel} available. `
        + `Prompts remain subject to the SQL guardrail and audit trail.`,
      latencyMs: 450
    };
  }
  // Cheap authenticated probe: list models.
  const req = provider.id === 'claude'
    ? { url: `${provider.endpoint}/v1/models`, headers: { 'x-api-key': sessionSecrets.aiKey, 'anthropic-version': '2023-06-01' } }
    : { url: `${provider.endpoint}/v1/models`, headers: { Authorization: `Bearer ${sessionSecrets.aiKey}` } };
  const res = await bridge.httpTest({ ...req, timeoutMs: settings.gateway.timeoutS * 1000 });
  return {
    ok: res.ok,
    detail: res.ok
      ? `${provider.label} reachable and key accepted (HTTP ${res.status}, ${res.latencyMs} ms).`
      : `${provider.label} test failed: ${res.error || `HTTP ${res.status}${res.status === 401 ? ' — check the API key' : ''}`}.`,
    latencyMs: res.latencyMs
  };
}

function trimSlash(u) { return String(u || '').replace(/\/+$/, ''); }
function walletName(s) { return (sessionSecrets.walletPath || s.walletFileName || '').split(/[\\/]/).pop() || '—'; }

// ---------------------------------------------------------------------------
// ADW dictionary (schemas → tables). In live mode this is served by the
// gateway from ALL_TABLES/ALL_TAB_COLUMNS; the demo dictionary mirrors the
// blueprint's layered model so the browser behaves identically.
// ---------------------------------------------------------------------------

function seededRows(name, lo, hi) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return lo + (h % (hi - lo));
}

const CORE_TABLES = [
  ['DIM_DATE', 'Conformed calendar & fiscal dates', ['date_key', 'calendar_date', 'fiscal_year', 'accounting_period_name', 'week', 'working_day_flag']],
  ['DIM_ENTERPRISE_ORG', 'Effective-dated organisation hierarchy', ['org_key', 'cluster_name', 'company_name', 'business_unit_name', 'department_name', 'cost_center_code']],
  ['DIM_ACCOUNT_COMBINATION', 'Chart-of-accounts combinations', ['account_key', 'natural_account_code', 'natural_account_name', 'cost_center_code', 'account_class']],
  ['DIM_CUSTOMER', 'Customer master', ['customer_key', 'customer_group', 'customer_name', 'site_name', 'industry', 'credit_profile']],
  ['DIM_SUPPLIER', 'Supplier master', ['supplier_key', 'supplier_category', 'supplier_name', 'site_name', 'bank_sensitivity_flag']],
  ['DIM_ITEM', 'Item master & product hierarchy', ['item_key', 'item_number', 'item_description', 'item_category_name', 'uom', 'planner']],
  ['DIM_WORKER', 'Worker/assignment master (restricted)', ['worker_key', 'assignment_id', 'legal_employer_name', 'department_name', 'grade_name', 'position_name']],
  ['DIM_SALES_OWNER', 'Sales owner / territory', ['sales_owner_key', 'sales_owner_name', 'territory']],
  ['DIM_INVENTORY_ORG', 'Inventory organisations', ['inventory_org_key', 'inventory_org_name', 'business_unit_name']],
  ['FCT_GL_BALANCE', 'GL balances by period/account (grain: ledger·period·account)', ['org_key', 'account_key', 'period_end_date_key', 'opening_balance_amt', 'closing_balance_amt', 'budget_amt', 'refresh_timestamp']],
  ['FCT_GL_JOURNAL', 'Posted journal lines', ['journal_id', 'line_number', 'accounting_date', 'entered_debit_amt', 'entered_credit_amt', 'source', 'preparer']],
  ['FCT_AP_INVOICE', 'Supplier invoices & payments', ['invoice_id', 'supplier_key', 'invoice_amt', 'paid_amt', 'due_date', 'payment_status']],
  ['FCT_AR_TRANSACTION', 'Receivables transactions & receipts', ['transaction_id', 'customer_key', 'billed_amt', 'open_amt', 'due_date', 'collection_status']],
  ['FCT_CASH_POSITION', 'Daily bank cash positions', ['bank_account_key', 'org_key', 'date_key', 'closing_cash_amt', 'inflow_amt', 'outflow_amt']],
  ['FCT_PAYROLL_COST', 'Monthly payroll cost (restricted)', ['org_key', 'grade_key', 'period_key', 'gross_pay_amt', 'employer_cost_amt']],
  ['FCT_INVENTORY_DAILY', 'Daily inventory positions', ['item_key', 'inventory_org_key', 'date_key', 'on_hand_quantity', 'inventory_value_amt', 'days_of_supply']],
  ['FCT_PO_COMMITMENT', 'PO lines & commitments', ['po_line_id', 'supplier_key', 'item_key', 'committed_amt', 'received_amt', 'invoiced_amt']],
  ['FCT_SPEND', 'Spend allocations', ['supplier_key', 'org_key', 'period_key', 'spend_amt', 'off_contract_amt']],
  ['FCT_OPPORTUNITY_SNAPSHOT', 'Daily opportunity snapshots', ['opportunity_id', 'snapshot_date_key', 'sales_owner_key', 'opportunity_amount', 'win_probability', 'sales_stage_name']],
  ['FCT_ORDER_FULFILMENT', 'Customer order lines & fulfilment milestones', ['order_line_id', 'customer_key', 'promised_date', 'shipped_date', 'otif_flag', 'backlog_amt']]
];

const STG_TABLES = [
  ['STG_GL_BALANCE', 'Cleansed GL extract (dates, currencies, keys standardised)'],
  ['STG_AP_INVOICE', 'Cleansed AP extract'],
  ['STG_WORKFORCE', 'Cleansed HCM assignment extract'],
  ['STG_INVENTORY_TXN', 'Cleansed inventory transactions'],
  ['STG_OPPORTUNITY', 'Cleansed CX opportunity extract']
];

const RAW_TABLES = [
  ['RAW_BICC_GL_EXTRACT', 'Immutable BICC landing — General Ledger'],
  ['RAW_BICC_AP_EXTRACT', 'Immutable BICC landing — Payables'],
  ['RAW_BICC_HCM_EXTRACT', 'Immutable BICC landing — HCM'],
  ['RAW_BICC_SCM_EXTRACT', 'Immutable BICC landing — Supply Chain'],
  ['RAW_REST_CX_PAYLOAD', 'Immutable REST landing — CX Sales']
];

export function adwDictionary() {
  const fresh = dataFreshness();
  return [
    {
      schema: 'INNOVATIA_RPT',
      description: 'Business-facing semantic layer — the ONLY schema exposed to dashboards, the AI planner and OAC.',
      exposed: true,
      tables: VIEWS.map((v) => ({
        name: v.name,
        type: 'VIEW',
        comment: v.grain,
        domain: v.domain,
        secure: v.secure,
        columns: [...v.dims, ...v.measures, 'data_refresh_timestamp'],
        measures: v.measures,
        dims: v.dims,
        rows: seededRows(v.name, 12000, 8_400_000),
        refresh: v.refresh,
        owner: v.owner,
        quality: (fresh.find((f) => f.view === v.name)?.quality) ?? 96 + (seededRows(v.name, 0, 35) / 10)
      }))
    },
    {
      schema: 'INNOVATIA_CORE',
      description: 'Conformed dimensions and granular facts (DIM_*/FCT_*). Source for reporting views — not exposed to dashboards.',
      exposed: false,
      tables: CORE_TABLES.map(([name, comment, columns]) => ({
        name, type: 'TABLE', comment, columns: columns || [], rows: seededRows(name, 50_000, 42_000_000)
      }))
    },
    {
      schema: 'INNOVATIA_STG',
      description: 'Standardised staging (STG_*). Transformation only — never exposed.',
      exposed: false,
      tables: STG_TABLES.map(([name, comment]) => ({ name, type: 'TABLE', comment, columns: [], rows: seededRows(name, 100_000, 60_000_000) }))
    },
    {
      schema: 'INNOVATIA_RAW',
      description: 'Immutable landing copies of approved Fusion extracts (RAW_*). Never exposed to OAC or the AI planner.',
      exposed: false,
      tables: RAW_TABLES.map(([name, comment]) => ({ name, type: 'TABLE', comment, columns: [], rows: seededRows(name, 200_000, 90_000_000) }))
    }
  ];
}

// ---------------------------------------------------------------------------
// Table insight profile → dashboard seed. This is what "build a dashboard
// from this table" runs on: measures/dimensions detected from the reporting
// contract, freshness and quality, and the matching governed intent.
// ---------------------------------------------------------------------------

const DOMAIN_FALLBACK_INTENT = {
  FIN: 'fin-exec', HCM: 'hcm-workforce', SCM: 'scm-spend',
  CX: 'cx-pipeline', XFN: 'xfn-ccc', SHARED: 'fin-exec'
};

export function intentForView(viewName) {
  const direct = allIntents().find((i) => i.view === viewName);
  if (direct) return direct.id;
  const view = VIEW_INDEX.get(viewName);
  return DOMAIN_FALLBACK_INTENT[view?.domain || 'FIN'];
}

// ---------------------------------------------------------------------------
// SQL Workbench execution.
//
// Two lanes, per §12.3:
//  * Governed lane (all roles): statements pass the SELECT-only guardrail —
//    identical to what the AI planner is allowed to run.
//  * Engineering lane (Platform Administrator + read-write connection only):
//    DDL/DML/PL-SQL permitted for data-engineering work. Never available to
//    the AI planner or dashboards, and every statement is audited.
// ---------------------------------------------------------------------------

const DEMO_ROWSETS = {
  RPT_FIN_GL_BALANCE_PERIOD_V: () => gl().filter((r) => r.period.key === MONTHS[MONTHS.length - 1].key).slice(0, 50)
    .map((r) => ({ company_name: r.company, cost_center_name: r.costCentre, natural_account_name: r.accountName, accounting_period_name: r.period.periodName, closing_balance_amt: Math.round(r.actual), budget_amt: Math.round(r.budget), budget_variance_amt: Math.round(r.variance) })),
  RPT_FIN_AP_AGEING_V: () => apAgeing().map((r) => ({ supplier_name: r.supplier, ageing_bucket: r.bucket, outstanding_amt: r.outstanding, overdue_amt: r.overdue ? r.outstanding : 0 })),
  RPT_FIN_AR_AGEING_V: () => arAgeing().map((r) => ({ customer_name: r.customer, ageing_bucket: r.bucket, open_amt: r.open, overdue_amt: r.overdue ? r.open : 0 })),
  RPT_FIN_CASH_DAILY_POSITION_V: () => cashDaily().slice(-60).map((r) => ({ bank_name: r.bank, company_name: r.company, calendar_date: r.date.toISOString().slice(0, 10), closing_cash_amt: Math.round(r.closing), inflow_amt: Math.round(r.inflow), outflow_amt: Math.round(r.outflow) })),
  RPT_HCM_WORKFORCE_SNAPSHOT_V: () => workforce().filter((r) => r.period.key === MONTHS[MONTHS.length - 1].key)
    .map((r) => ({ legal_employer_name: r.legalEmployer, department_name: r.department, headcount: r.headcount, fte: r.fte, vacancy_count: r.vacancies })),
  SEC_HCM_PAYROLL_COST_V: () => workforce().filter((r) => r.period.key === MONTHS[MONTHS.length - 1].key)
    .map((r) => ({ legal_employer_name: r.legalEmployer, department_name: r.department, gross_pay_amt: Math.round(r.payrollCost * 0.82), employer_cost_amt: Math.round(r.payrollCost) })),
  RPT_SCM_SPEND_ANALYSIS_V: () => spend().filter((r) => r.period.key === MONTHS[MONTHS.length - 1].key)
    .map((r) => ({ supplier_category: r.category, supplier_name: r.supplier, business_unit_name: r.businessUnit, spend_amt: Math.round(r.spend) })),
  RPT_SCM_STOCKOUT_RISK_V: () => inventory().map((r) => ({ item_category_name: r.category, item_number: r.item, inventory_org_name: r.org, days_of_supply: r.daysOfSupply, stockout_risk_score: r.stockoutRisk === 'High' ? 90 : r.stockoutRisk === 'Medium' ? 55 : 15 })),
  RPT_SCM_INVENTORY_POSITION_DAILY_V: () => inventory().map((r) => ({ business_unit_name: r.businessUnit, inventory_org_name: r.org, item_number: r.item, on_hand_quantity: r.onHand, inventory_value_amt: r.value, days_of_supply: r.daysOfSupply })),
  RPT_CX_OPPORTUNITY_PIPELINE_SNAPSHOT_V: () => pipeline().map((r) => ({ cluster_name: r.cluster, business_unit_name: r.businessUnit, sales_owner_name: r.owner, opportunity_number: r.opportunity, sales_stage_name: r.stage, opportunity_amount: r.amount, weighted_pipeline_amt: r.weighted, close_date: r.closeDate })),
  RPT_XFN_CASH_CONVERSION_CYCLE_V: () => cashConversion().filter((r) => r.period.key === MONTHS[MONTHS.length - 1].key)
    .map((r) => ({ company_name: r.company, accounting_period_name: r.period.periodName, dso_days: +r.dso.toFixed(1), dpo_days: +r.dpo.toFixed(1), inventory_days: +r.dio.toFixed(1), ccc_days: +r.ccc.toFixed(1) })),
  RPT_DATA_FRESHNESS_V: () => dataFreshness().map((r) => ({ source_domain: r.domain, reporting_view: r.view, batch_id: r.batch, refresh_status: r.status, refresh_age_hours: r.ageH, quality_score: r.quality }))
};

function genericRows(view, limit = 25) {
  const cols = [...view.dims, ...view.measures];
  const rows = [];
  for (let i = 0; i < Math.min(limit, 12); i++) {
    const row = {};
    for (const c of cols) {
      row[c] = /_(amt|quantity|count|score|days|pct|rate)/.test(c) || view.measures.includes(c)
        ? seededRows(`${view.name}|${c}|${i}`, 10, 990000)
        : `${c.replace(/_/g, ' ').toUpperCase().slice(0, 3)}-${1000 + seededRows(`${view.name}|${c}|${i}`, 0, 8999)}`;
    }
    rows.push(row);
  }
  return rows;
}

function statementKind(sql) {
  const first = sql.trim().replace(/^--.*$/m, '').replace(/^[\s(]+/, '').split(/\s+/)[0]?.toUpperCase();
  if (first === 'SELECT' || first === 'WITH') return 'SELECT';
  if (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE'].includes(first)) return 'DML';
  if (['CREATE', 'ALTER', 'DROP', 'COMMENT', 'GRANT', 'REVOKE', 'RENAME'].includes(first)) return 'DDL';
  return first || 'UNKNOWN';
}

/**
 * Execute a workbench statement. Returns
 * { ok, lane, kind, message, columns?, rows?, errors? }.
 */
// Run a statement against the live ADW connection (direct, via the main
// process). Returns null when not in live mode / no driver, so callers fall
// back to the demo dataset.
async function runLive(sql, { settings, bridge, maxRows }) {
  if (settings.mode !== 'live' || !bridge?.adwQuery) return null;
  const s = settings.adw;
  return bridge.adwQuery({
    adw: { username: s.username, serviceName: s.serviceName, host: s.host, access: s.access, walletPassword: sessionSecrets.walletPassword || '' },
    walletPath: sessionSecrets.walletPath || s.walletFileName,
    password: sessionSecrets.adwPassword,
    sql, maxRows: maxRows || settings.rowLimit,
    timeoutMs: settings.gateway.timeoutS * 1000
  });
}

export async function executeWorkbenchSql(sql, { role, settings, bridge }) {
  const kind = statementKind(sql);
  const engineering = kind === 'DML' || kind === 'DDL' || /\bBEGIN\b|\bDECLARE\b/i.test(sql);

  if (engineering) {
    if (!role.canAdmin) {
      return {
        ok: false, lane: 'governed', kind,
        errors: [`${kind} statements require the Platform Administrator role. Dashboard and analyst access is SELECT-only (§12.3).`]
      };
    }
    if (settings.adw.access !== 'write') {
      return {
        ok: false, lane: 'engineering', kind,
        errors: ['The ADW connection is read-only. Switch the connection to read-write under Connections → Oracle ADW to run DDL/DML (engineering pipeline account).']
      };
    }
    const live = await runLive(sql, { settings, bridge });
    if (live && !live.ok) return { ok: false, lane: 'engineering', kind, errors: [`ADW: ${live.error}`] };
    await sleep(live ? 0 : (settings.mode === 'demo' ? 500 : 50));
    const affected = live ? live.rowsAffected : (kind === 'DDL' ? 0 : seededRows(sql, 1, 4200));
    return {
      ok: true, lane: 'engineering', kind,
      message: kind === 'DDL'
        ? `${kind} statement executed${live ? ' on ADW' : (settings.mode === 'demo' ? ' (demo simulation — no database attached)' : '')}. Object catalogued; remember to register new RPT_/SEC_ views in the governed catalogue before exposing them to dashboards.`
        : `${affected.toLocaleString('en-GB')} row${affected === 1 ? '' : 's'} affected${live ? ' on ADW' : (settings.mode === 'demo' ? ' (demo simulation — no database attached)' : '')}.`,
      warning: 'Executed on the engineering (read-write) lane. This statement is outside dashboard governance and has been written to the audit trail.'
    };
  }

  // Governed lane — same rules as the AI planner.
  const validation = validateSql(sql, { role, rowLimit: settings.rowLimit });
  if (!validation.ok) return { ok: false, lane: 'governed', kind, errors: validation.errors };

  const viewName = validation.views[0]?.name;
  const view = VIEW_INDEX.get(viewName);

  const live = await runLive(validation.sql, { settings, bridge });
  if (live && !live.ok) return { ok: false, lane: 'governed', kind: 'SELECT', errors: [`ADW: ${live.error}`] };

  let rows, columns;
  if (live) {
    rows = live.rows; columns = live.columns;
  } else {
    await sleep(settings.mode === 'demo' ? 350 : 50);
    rows = (DEMO_ROWSETS[viewName] ? DEMO_ROWSETS[viewName]() : genericRows(view)).slice(0, settings.rowLimit);
    columns = rows.length ? Object.keys(rows[0]) : [];
  }
  if (view?.secure && !role.canSeeSecure) {
    rows = rows.map((r) => {
      const masked = { ...r };
      for (const k of Object.keys(masked)) if (/name$/i.test(k) && !/company|employer|department/i.test(k)) masked[k] = '•••• masked ••••';
      return masked;
    });
  }
  return {
    ok: true, lane: 'governed', kind: 'SELECT',
    message: `${rows.length.toLocaleString('en-GB')} rows returned from ${viewName}${live ? ' (live ADW)' : (settings.mode === 'demo' ? ' (demo dataset)' : '')}.`,
    columns,
    rows,
    warnings: validation.warnings
  };
}

export function profileTable(table) {
  if (!table.measures) return null; // only RPT_/SEC_ views carry the contract
  const view = VIEW_INDEX.get(table.name);
  const intentId = intentForView(table.name);
  const intent = allIntents().find((i) => i.id === intentId);
  return {
    view: table.name,
    domain: DOMAINS[view.domain].label,
    grain: view.grain,
    rows: table.rows,
    measures: table.measures,
    dims: table.dims,
    refresh: view.refresh,
    quality: table.quality,
    secure: view.secure,
    intentId,
    recommendedDashboard: intent?.title || 'Executive overview',
    insight: [
      `${table.measures.length || 'No dedicated'} measure column${table.measures.length === 1 ? '' : 's'} and ${table.dims.length} dimension${table.dims.length === 1 ? '' : 's'} detected from the reporting contract.`,
      `~${table.rows.toLocaleString('en-GB')} rows at the documented grain; refresh cadence “${view.refresh}”, current quality ${Number(table.quality).toFixed(1)}%.`,
      view.secure ? 'Secure view: rows are masked/aggregated outside authorised roles.' : 'Standard governed view: row-level security inherited from the enterprise model.',
      `Best-fit governed page: ${intent?.title || 'domain executive overview'}.`
    ]
  };
}
