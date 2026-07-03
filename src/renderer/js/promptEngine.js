'use strict';

import { VIEW_INDEX, DRILL_HIERARCHIES } from './catalog.js';
import { validateSql } from './guardrail.js';
import { ENTERPRISE, companies } from './data.js';

// ---------------------------------------------------------------------------
// Prompt planner (§12.1 steps 1–3).
//
// Classifies an approved business question into a governed dashboard intent,
// resolves scope (company / business unit / period) through the glossary,
// drafts the controlled SQL for the primary dataset and returns an
// interpretation the user confirms before anything renders. Only catalogued
// views can be referenced; the guardrail validates every draft.
// ---------------------------------------------------------------------------

const INTENTS = [
  {
    id: 'fin-exec', domain: 'FIN', title: 'Finance Executive Overview',
    view: 'RPT_FIN_GL_BALANCE_PERIOD_V', drill: 'account',
    keywords: ['revenue', 'gross margin', 'operating cost', 'ebitda', 'profit', 'p&l', 'income statement', 'budget', 'finance overview', 'financial performance'],
    sql: (scope) => `SELECT org.company_name, coa.cost_center_name, coa.natural_account_name,
       d.accounting_period_name,
       SUM(f.closing_balance_amt) AS actual_amt,
       SUM(f.budget_amt)          AS budget_amt,
       SUM(f.budget_variance_amt) AS variance_amt,
       MAX(f.data_refresh_timestamp) AS data_refresh_timestamp
FROM RPT_FIN_GL_BALANCE_PERIOD_V f
JOIN RPT_DIM_DATE_V d ON d.accounting_period_name = f.accounting_period_name
JOIN RPT_DIM_ENTERPRISE_ORG_V org ON org.company_name = f.company_name
JOIN RPT_DIM_ACCOUNT_COMBINATION_V coa ON coa.natural_account_name = f.natural_account_name
WHERE d.fiscal_year = :p_fiscal_year${scope.companyFilter}
GROUP BY org.company_name, coa.cost_center_name, coa.natural_account_name, d.accounting_period_name`
  },
  {
    id: 'fin-expense-variance', domain: 'FIN', title: 'Expense Variance Analysis',
    view: 'RPT_FIN_BUDGET_VS_ACTUAL_V', drill: 'account',
    keywords: ['expense variance', 'variance against budget', 'drivers of', 'cost variance', 'explain the variance', 'why did cost'],
    sql: (scope) => `SELECT b.company_name, b.cost_center_name, b.natural_account_name,
       b.accounting_period_name,
       SUM(b.actual_amt)   AS actual_amt,
       SUM(b.budget_amt)   AS budget_amt,
       SUM(b.variance_amt) AS variance_amt
FROM RPT_FIN_BUDGET_VS_ACTUAL_V b
WHERE b.accounting_period_name = :p_period${scope.companyFilter}
GROUP BY b.company_name, b.cost_center_name, b.natural_account_name, b.accounting_period_name`
  },
  {
    id: 'fin-ap', domain: 'FIN', title: 'Payables & Supplier Exposure',
    view: 'RPT_FIN_AP_AGEING_V', drill: 'supplier',
    keywords: ['overdue payables', 'payables', 'payment terms', 'ap ageing', 'suppliers account', 'overdue invoices', 'accounts payable'],
    sql: () => `SELECT a.supplier_name, a.ageing_bucket,
       SUM(a.outstanding_amt) AS outstanding_amt,
       SUM(a.overdue_amt)     AS overdue_amt
FROM RPT_FIN_AP_AGEING_V a
JOIN RPT_DIM_SUPPLIER_360_V s ON s.supplier_name = a.supplier_name
GROUP BY a.supplier_name, a.ageing_bucket
ORDER BY SUM(a.overdue_amt) DESC`
  },
  {
    id: 'fin-cash', domain: 'FIN', title: 'Daily Cash Position & Forecast',
    view: 'RPT_FIN_CASH_DAILY_POSITION_V', drill: 'org',
    keywords: ['cash position', 'cash forecast', 'bank', 'treasury', 'daily cash', 'liquidity'],
    sql: (scope) => `SELECT c.bank_name, c.company_name, c.calendar_date, c.currency_code,
       SUM(c.closing_cash_amt)  AS closing_cash_amt,
       SUM(c.inflow_amt)        AS inflow_amt,
       SUM(c.outflow_amt)       AS outflow_amt,
       SUM(c.forecast_cash_amt) AS forecast_cash_amt
FROM RPT_FIN_CASH_DAILY_POSITION_V c
WHERE c.calendar_date >= :p_from_date${scope.companyFilter}
GROUP BY c.bank_name, c.company_name, c.calendar_date, c.currency_code`
  },
  {
    id: 'hcm-workforce', domain: 'HCM', title: 'Workforce Executive Overview',
    view: 'RPT_HCM_WORKFORCE_SNAPSHOT_V', drill: 'workforce',
    keywords: ['headcount', 'fte', 'vacancy', 'hires', 'exits', 'workforce', 'joiners', 'leavers', 'attrition'],
    sql: (scope) => `SELECT w.legal_employer_name, w.department_name,
       SUM(w.headcount)     AS headcount,
       SUM(w.fte)           AS fte,
       SUM(w.vacancy_count) AS vacancy_count
FROM RPT_HCM_WORKFORCE_SNAPSHOT_V w
JOIN RPT_DIM_ENTERPRISE_ORG_V org ON org.company_name = w.legal_employer_name
WHERE 1 = 1${scope.companyFilter}
GROUP BY w.legal_employer_name, w.department_name`
  },
  {
    id: 'hcm-payroll', domain: 'HCM', title: 'People Cost Analysis (Secure)',
    view: 'SEC_HCM_PAYROLL_COST_V', drill: 'workforce',
    keywords: ['payroll cost', 'payroll increased', 'people cost', 'cost per fte payroll', 'compensation cost'],
    sql: (scope) => `SELECT p.legal_employer_name, p.department_name, p.grade_name,
       p.accounting_period_name,
       SUM(p.gross_pay_amt)      AS gross_pay_amt,
       SUM(p.employer_cost_amt)  AS employer_cost_amt,
       SUM(p.cost_variance_amt)  AS cost_variance_amt
FROM SEC_HCM_PAYROLL_COST_V p
WHERE p.accounting_period_name = :p_period${scope.companyFilter}
GROUP BY p.legal_employer_name, p.department_name, p.grade_name, p.accounting_period_name`
  },
  {
    id: 'hcm-absence', domain: 'HCM', title: 'Absence & Workforce Availability',
    view: 'RPT_HCM_ABSENCE_ACCRUAL_V', drill: 'workforce',
    keywords: ['absence', 'leave utilisation', 'leave balance', 'sick leave'],
    sql: () => `SELECT a.absence_plan, a.department_name,
       SUM(a.entitlement_days) AS entitlement_days,
       SUM(a.taken_days)       AS taken_days,
       SUM(a.balance_days)     AS balance_days,
       AVG(a.absence_rate_pct) AS absence_rate_pct
FROM RPT_HCM_ABSENCE_ACCRUAL_V a
GROUP BY a.absence_plan, a.department_name`
  },
  {
    id: 'scm-spend', domain: 'SCM', title: 'Procurement Spend Analysis',
    view: 'RPT_SCM_SPEND_ANALYSIS_V', drill: 'supplier',
    keywords: ['procurement spend', 'spend by category', 'supplier concentration', 'spend analysis', 'purchase order', 'supplier spend'],
    sql: (scope) => `SELECT s.supplier_category, s.supplier_name, s.business_unit_name,
       SUM(s.spend_amt)                    AS spend_amt,
       AVG(s.supplier_concentration_pct)   AS supplier_concentration_pct
FROM RPT_SCM_SPEND_ANALYSIS_V s
JOIN RPT_DIM_SUPPLIER_360_V sup ON sup.supplier_name = s.supplier_name
WHERE 1 = 1${scope.companyFilter}
GROUP BY s.supplier_category, s.supplier_name, s.business_unit_name
ORDER BY SUM(s.spend_amt) DESC`
  },
  {
    id: 'scm-stockout', domain: 'SCM', title: 'Inventory Availability & Stockout Risk',
    view: 'RPT_SCM_STOCKOUT_RISK_V', drill: 'item',
    keywords: ['stockout', 'days of supply', 'inventory risk', 'slow-moving', 'non-moving', 'inventory position', 'stock risk'],
    sql: () => `SELECT r.item_category_name, r.item_number, r.inventory_org_name, r.business_unit_name,
       AVG(r.days_of_supply)      AS days_of_supply,
       MAX(r.stockout_risk_score) AS stockout_risk_score
FROM RPT_SCM_STOCKOUT_RISK_V r
JOIN RPT_DIM_ITEM_360_V i ON i.item_number = r.item_number
GROUP BY r.item_category_name, r.item_number, r.inventory_org_name, r.business_unit_name
ORDER BY MAX(r.stockout_risk_score) DESC`
  },
  {
    id: 'cx-pipeline', domain: 'CX', title: 'Sales Pipeline Command Centre',
    view: 'RPT_CX_OPPORTUNITY_PIPELINE_SNAPSHOT_V', drill: 'customer',
    keywords: ['pipeline', 'opportunity', 'weighted value', 'sales stage', 'close-date', 'deals'],
    sql: (scope) => `SELECT o.cluster_name, o.business_unit_name, o.sales_owner_name, o.sales_stage_name,
       SUM(o.opportunity_amount)    AS opportunity_amount,
       SUM(o.weighted_pipeline_amt) AS weighted_pipeline_amt,
       AVG(o.days_since_last_activity) AS days_since_last_activity
FROM RPT_CX_OPPORTUNITY_PIPELINE_SNAPSHOT_V o
WHERE 1 = 1${scope.companyFilter}
GROUP BY o.cluster_name, o.business_unit_name, o.sales_owner_name, o.sales_stage_name`
  },
  {
    id: 'cx-forecast', domain: 'CX', title: 'Forecast Accuracy & Sales Performance',
    view: 'RPT_CX_FORECAST_ACCURACY_V', drill: 'customer',
    keywords: ['forecast accuracy', 'forecast bias', 'attainment', 'sales performance'],
    sql: () => `SELECT f.accounting_period_name, f.business_unit_name, f.sales_owner_name,
       AVG(f.forecast_variance_pct) AS forecast_variance_pct,
       AVG(f.attainment_pct)        AS attainment_pct,
       AVG(f.forecast_bias_pct)     AS forecast_bias_pct
FROM RPT_CX_FORECAST_ACCURACY_V f
GROUP BY f.accounting_period_name, f.business_unit_name, f.sales_owner_name`
  },
  {
    id: 'xfn-ccc', domain: 'XFN', title: 'Cash Conversion Cycle',
    view: 'RPT_XFN_CASH_CONVERSION_CYCLE_V', drill: 'org',
    keywords: ['cash conversion', 'dso', 'dpo', 'inventory days', 'working capital cycle'],
    sql: (scope) => `SELECT c.company_name, c.accounting_period_name,
       AVG(c.dso_days)       AS dso_days,
       AVG(c.dpo_days)       AS dpo_days,
       AVG(c.inventory_days) AS inventory_days,
       AVG(c.ccc_days)       AS ccc_days
FROM RPT_XFN_CASH_CONVERSION_CYCLE_V c
WHERE 1 = 1${scope.companyFilter}
GROUP BY c.company_name, c.accounting_period_name`
  },
  {
    id: 'xfn-productivity', domain: 'XFN', title: 'Workforce Cost & Productivity',
    view: 'RPT_XFN_WORKFORCE_COST_PRODUCTIVITY_V', drill: 'org',
    keywords: ['revenue per fte', 'cost per fte', 'productivity', 'workforce cost'],
    sql: (scope) => `SELECT p.company_name, p.department_name, p.accounting_period_name,
       AVG(p.cost_per_fte_amt)    AS cost_per_fte_amt,
       AVG(p.revenue_per_fte_amt) AS revenue_per_fte_amt
FROM RPT_XFN_WORKFORCE_COST_PRODUCTIVITY_V p
WHERE 1 = 1${scope.companyFilter}
GROUP BY p.company_name, p.department_name, p.accounting_period_name`
  }
];

export const INTENT_INDEX = new Map(INTENTS.map((i) => [i.id, i]));

function detectCompany(text) {
  const t = text.toLowerCase();
  for (const co of companies()) {
    const short = co.name.replace('InnovatIA ', '').toLowerCase();
    if (t.includes(short)) return co.name;
  }
  return null;
}

function detectPeriod(text) {
  const t = text.toLowerCase();
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  for (let i = 0; i < 12; i++) {
    if (t.includes(monthNames[i])) return { type: 'month', month: i + 1, label: monthNames[i][0].toUpperCase() + monthNames[i].slice(1) };
  }
  if (/year[- ]to[- ]date|ytd/.test(t)) return { type: 'ytd', label: 'Year to date' };
  if (/last 12 months|12 months|twelve months/.test(t)) return { type: 'r12', label: 'Last 12 months' };
  if (/next 30 days|30 days/.test(t)) return { type: 'd30', label: 'Next 30 days' };
  if (/quarter/.test(t)) return { type: 'quarter', label: 'Current quarter' };
  return { type: 'r12', label: 'Last 12 months' };
}

/** Classify a prompt into a governed plan the user can confirm or refine. */
export function planPrompt(text, { role } = {}) {
  const t = (text || '').toLowerCase();
  let best = null, bestScore = 0;
  for (const intent of INTENTS) {
    let score = 0;
    for (const kw of intent.keywords) if (t.includes(kw)) score += kw.split(' ').length + 1;
    if (score > bestScore) { best = intent; bestScore = score; }
  }
  const matched = !!best;
  if (!best) best = INTENTS[0]; // default to the Finance executive page

  const company = detectCompany(text);
  const period = detectPeriod(text);
  const scope = {
    company,
    period,
    companyFilter: company ? `\n  AND org_or_view.company_name = :p_company` : ''
  };
  // Keep the bind-style filter readable in the drafted SQL.
  const sqlDraft = best.sql({ companyFilter: company ? `\n  AND company_name = :p_company /* ${company} */` : '' });

  const view = VIEW_INDEX.get(best.view);
  const hierarchy = DRILL_HIERARCHIES.find((h) => h.id === best.drill);

  const clarifications = [];
  if (/revenue/.test(t) && !/(invoice|billed|collect|cash|recognis)/.test(t)) {
    clarifications.push('“Revenue” is interpreted as invoiced revenue from the GL revenue accounts (glossary default). Refine the prompt if you need revenue accounting or cash collections.');
  }
  if (view?.secure && role && !role.canSeeSecure) {
    clarifications.push(`This plan touches secure view ${view.name}: results will be aggregated/masked for your role.`);
  }

  let confidence = matched ? Math.min(0.97, 0.62 + bestScore * 0.05) : 0.45;
  if (clarifications.length) confidence = Math.min(confidence, 0.8);

  const validation = validateSql(sqlDraft, { role });

  return {
    intent: best,
    matched,
    confidence,
    clarifications,
    scope,
    interpretation: {
      question: text,
      dashboard: best.title,
      domain: best.domain,
      primaryView: best.view,
      supportingViews: validation.views.map((v) => v.name).filter((n) => n !== best.view),
      period: period.label,
      companyScope: company || `All companies (${ENTERPRISE.group})`,
      currency: `${ENTERPRISE.reportingCurrency} (common reporting currency)`,
      drillRoute: hierarchy ? hierarchy.route.join(' → ') : '—',
      visualPlan: 'KPI row · trend & forecast · driver/mix · AI insight & exceptions · secure detail · governance footer'
    },
    sql: validation.sql,
    validation
  };
}

export function allIntents() { return INTENTS; }
