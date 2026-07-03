'use strict';

// Unit tests for the governed engines (guardrail, prompt planner, insights).
// Runs in plain Node: `npm test`.

const assert = require('assert');

async function main() {
  const { validateSql } = await import('../src/renderer/js/guardrail.js');
  const { planPrompt, allIntents } = await import('../src/renderer/js/promptEngine.js');
  const { decomposeVariance, linearForecast, narrative } = await import('../src/renderer/js/insights.js');
  const { ROLES, VIEWS } = await import('../src/renderer/js/catalog.js');

  const analyst = ROLES.find((r) => r.id === 'analyst');
  const admin = ROLES.find((r) => r.id === 'admin');
  let passed = 0;
  const test = (name, fn) => {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
  };

  console.log('SQL guardrail (§12.3)');
  test('permits a valid SELECT on an approved view and applies the row limit', () => {
    const r = validateSql('SELECT company_name, SUM(closing_balance_amt) FROM RPT_FIN_GL_BALANCE_PERIOD_V GROUP BY company_name', { role: analyst });
    assert.ok(r.ok, r.errors.join('; '));
    assert.match(r.sql, /FETCH FIRST 500 ROWS ONLY/);
  });
  test('blocks DML (UPDATE)', () => {
    const r = validateSql("UPDATE RPT_FIN_GL_BALANCE_PERIOD_V SET budget_amt = 0", { role: admin });
    assert.ok(!r.ok);
  });
  test('blocks DDL (DROP) embedded after a SELECT', () => {
    const r = validateSql('SELECT 1 FROM RPT_DIM_DATE_V; DROP TABLE FCT_GL_BALANCE', { role: admin });
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /DROP|Multiple statements/i.test(e)));
  });
  test('blocks PL/SQL blocks', () => {
    const r = validateSql('BEGIN NULL; END;', { role: admin });
    assert.ok(!r.ok);
  });
  test('blocks unapproved objects (RAW_/FCT_ never exposed)', () => {
    const r = validateSql('SELECT * FROM RAW_GL_EXTRACT', { role: admin });
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => e.includes('not an approved reporting view')));
  });
  test('blocks schema-qualified and database-link access', () => {
    assert.ok(!validateSql('SELECT * FROM APPS.GL_BALANCES', { role: admin }).ok);
    assert.ok(!validateSql('SELECT * FROM RPT_DIM_DATE_V@remote_db', { role: admin }).ok);
  });
  test('blocks unsafe packages', () => {
    const r = validateSql("SELECT UTL_HTTP.REQUEST('http://x') FROM RPT_DIM_DATE_V", { role: admin });
    assert.ok(!r.ok);
  });
  test('blocks sensitive columns by masking policy', () => {
    const r = validateSql('SELECT salary FROM SEC_HCM_PAYROLL_COST_V', { role: admin });
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => e.includes('salary')));
  });
  test('warns (masks) on secure views for non-privileged roles', () => {
    const r = validateSql('SELECT department_name, SUM(gross_pay_amt) FROM SEC_HCM_PAYROLL_COST_V GROUP BY department_name', { role: analyst });
    assert.ok(r.ok);
    assert.ok(r.warnings.some((w) => w.includes('masked')));
  });
  test('is not fooled by keywords inside string literals', () => {
    const r = validateSql("SELECT company_name FROM RPT_FIN_GL_BALANCE_PERIOD_V WHERE company_name <> 'DROP TABLE'", { role: analyst });
    assert.ok(r.ok, r.errors.join('; '));
  });

  console.log('Prompt planner (§12.1, §14.1)');
  const cases = [
    ['Show year-to-date revenue, operating cost and gross margin by company, with a monthly trend', 'fin-exec'],
    ['Which suppliers account for the largest overdue payables balance?', 'fin-ap'],
    ['Show daily cash position by bank and company, forecast the next 30 days', 'fin-cash'],
    ['Show current headcount, FTE, hires, exits and vacancy rate by legal employer', 'hcm-workforce'],
    ['Explain why payroll cost increased this month by business unit', 'hcm-payroll'],
    ['Show procurement spend by category and supplier for the year', 'scm-spend'],
    ['Which inventory items are at risk of stockout in the next 30 days?', 'scm-stockout'],
    ['Show the sales pipeline by cluster, business unit and stage, including weighted value', 'cx-pipeline'],
    ['Show the cash conversion cycle by company', 'xfn-ccc'],
    ['Compare revenue per FTE and workforce cost per FTE by business unit', 'xfn-productivity']
  ];
  for (const [prompt, intent] of cases) {
    test(`"${prompt.slice(0, 52)}…" → ${intent}`, () => {
      const plan = planPrompt(prompt, { role: analyst });
      assert.strictEqual(plan.intent.id, intent);
      assert.ok(plan.validation.ok, `drafted SQL failed guardrail: ${plan.validation.errors.join('; ')}`);
      assert.ok(plan.confidence > 0.6);
    });
  }
  test('resolves company scope from the prompt', () => {
    const plan = planPrompt('Explain the drivers of the June expense variance against budget for the Nigeria business unit', { role: analyst });
    assert.strictEqual(plan.scope.company, 'InnovatIA Nigeria');
    assert.strictEqual(plan.scope.period.label, 'June');
  });
  test('every intent drafts SQL that passes its own guardrail', () => {
    for (const intent of allIntents()) {
      const sql = intent.sql({ companyFilter: '' });
      const r = validateSql(sql, { role: admin });
      assert.ok(r.ok, `${intent.id}: ${r.errors.join('; ')}`);
    }
  });
  test('flags ambiguous "revenue" for clarification', () => {
    const plan = planPrompt('Show revenue by company', { role: analyst });
    assert.ok(plan.clarifications.length > 0);
  });

  console.log('Insight engine (§10)');
  test('variance decomposition reconciles to the total', () => {
    const rows = [
      { key: 'A', actual: 120, comparative: 100 },
      { key: 'B', actual: 80, comparative: 100 },
      { key: 'A', actual: 30, comparative: 20 }
    ];
    const d = decomposeVariance(rows);
    assert.strictEqual(Math.round(d.totalVariance), 10);
    assert.strictEqual(d.drivers[0].key, 'A');
    const driverSum = d.entries.reduce((a, e) => a + e.variance, 0);
    assert.strictEqual(Math.round(driverSum), Math.round(d.totalVariance));
  });
  test('forecast returns the horizon with a widening confidence band', () => {
    const f = linearForecast([10, 12, 14, 16, 18, 20], 4);
    assert.strictEqual(f.points.length, 4);
    assert.strictEqual(f.band.length, 4);
    assert.ok(f.points[3] > f.points[0]);
    assert.ok(f.band[3][1] - f.band[3][0] >= f.band[0][1] - f.band[0][0]);
  });
  test('narrative quotes calculated drivers and states confidence', () => {
    const d = decomposeVariance([
      { key: 'Transport', actual: 190, comparative: 100 },
      { key: 'Admin', actual: 105, comparative: 100 }
    ]);
    const n = narrative({ metric: 'Operating cost', scopeLabel: 'plan', periodLabel: 'Jun-26', decomposition: d, freshnessPct: 98.7, fmt: (v) => v.toFixed(0), upIsGood: false });
    assert.ok(n.summary.includes('Transport'));
    assert.strictEqual(n.confidence, 'High');
    assert.ok(n.nextSteps.length >= 3);
  });

  console.log('Catalogue integrity (§2.2)');
  test('every view carries the mandatory reporting contract fields', () => {
    for (const v of VIEWS) {
      assert.ok(v.grain && v.owner && v.refresh && v.drill, `${v.name} missing contract fields`);
      assert.ok(/^(RPT_|SEC_)/.test(v.name), `${v.name} must be RPT_* or SEC_*`);
      if (v.name.startsWith('SEC_')) assert.ok(v.secure, `${v.name} must be flagged secure`);
    }
  });

  console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
