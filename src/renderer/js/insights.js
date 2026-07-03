'use strict';

// ---------------------------------------------------------------------------
// Advanced analytics & AI insight engine (§10).
//
// Everything here is deterministic and evidence-led: variance decomposition,
// least-squares forecasting with a residual confidence band, z-score anomaly
// flags and a root-cause narrative that quotes ONLY calculated drivers —
// never invented external causes. Outputs always carry data period, scope,
// method, confidence and a drill route (the §10 control requirements).
// Recommendations are informational; nothing here executes a transaction.
// ---------------------------------------------------------------------------

export function linearForecast(values, horizon = 6) {
  const n = values.length;
  const xs = values.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (values[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 0;
  const intercept = my - slope * mx;
  const resid = values.map((v, i) => v - (intercept + slope * i));
  const sd = Math.sqrt(resid.reduce((a, r) => a + r * r, 0) / Math.max(1, n - 2));
  const points = [], band = [];
  for (let h = 1; h <= horizon; h++) {
    const t = n - 1 + h;
    const yhat = intercept + slope * t;
    const spread = 1.28 * sd * Math.sqrt(1 + h / n); // ~80% interval, widening
    points.push(yhat);
    band.push([yhat - spread, yhat + spread]);
  }
  return { points, band, slope, sd };
}

export function anomalies(values, threshold = 2.2) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / n) || 1;
  return values.map((v, i) => ({ index: i, z: (v - mean) / sd }))
    .filter((p) => Math.abs(p.z) > threshold);
}

/**
 * Variance decomposition: given rows with { key, actual, comparative },
 * returns total variance and the most material contributors.
 */
export function decomposeVariance(rows, { topN = 5 } = {}) {
  const byKey = new Map();
  for (const r of rows) {
    const e = byKey.get(r.key) || { key: r.key, actual: 0, comparative: 0 };
    e.actual += r.actual;
    e.comparative += r.comparative;
    byKey.set(r.key, e);
  }
  const entries = [...byKey.values()].map((e) => ({ ...e, variance: e.actual - e.comparative }));
  const totalActual = entries.reduce((a, e) => a + e.actual, 0);
  const totalComparative = entries.reduce((a, e) => a + e.comparative, 0);
  const totalVariance = totalActual - totalComparative;
  const drivers = [...entries].sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance)).slice(0, topN);
  return { totalActual, totalComparative, totalVariance, drivers, entries };
}

/**
 * §10.2-style narrative. All figures quoted are computed from the dataset;
 * the freshness/quality inputs feed the confidence statement.
 */
export function narrative({ metric, scopeLabel, periodLabel, decomposition, freshnessPct, fmt, drillHint, upIsGood = false }) {
  const { totalActual, totalComparative, totalVariance, drivers } = decomposition;
  const pct = totalComparative ? (totalVariance / Math.abs(totalComparative)) * 100 : 0;
  const dir = totalVariance >= 0 ? 'above' : 'below';
  const good = (totalVariance >= 0) === upIsGood;

  const driverText = drivers.slice(0, 3)
    .map((d) => `${d.key} (${d.variance >= 0 ? '+' : '−'}${fmt(Math.abs(d.variance))})`)
    .join(', ');

  const confidence = freshnessPct >= 98 ? 'High' : freshnessPct >= 94 ? 'Medium' : 'Low';

  return {
    summary: `${metric} is ${Math.abs(pct).toFixed(1)}% ${dir} ${scopeLabel} for ${periodLabel}, driven primarily by ${driverText}.`,
    tone: good ? 'good' : 'attention',
    confidence,
    confidenceDetail: `${confidence} — ${freshnessPct.toFixed(1)}% of comparative and actual records are refreshed for the reporting period.`,
    method: 'Variance decomposition at consistent grain; drivers ranked by absolute contribution.',
    nextSteps: [
      `Drill to the top ${Math.min(3, drivers.length)} contributors: ${drivers.slice(0, 3).map((d) => d.key).join(', ')}.`,
      drillHint || 'Review the underlying transaction evidence in the detail zone.',
      'Compare the movement with operational volume and approved commitments for the same period.'
    ]
  };
}

/** Advisory recommendation cards (§10 guardrail: informational only). */
export function recommendationCards({ drivers, fmt, domain }) {
  const templates = {
    FIN: (d) => ({ title: `Review ${d.key}`, body: `Contributes ${fmt(Math.abs(d.variance))} of the variance. Inspect post-cut-off journals and recurring supplier invoices for this driver.`, owner: 'Financial Controller' }),
    HCM: (d) => ({ title: `Investigate ${d.key}`, body: `People-cost movement of ${fmt(Math.abs(d.variance))}. Review headcount changes, overtime and allowance signals at this level.`, owner: 'HR Business Partner' }),
    SCM: (d) => ({ title: `Check ${d.key}`, body: `Movement of ${fmt(Math.abs(d.variance))}. Review open POs, receipt exceptions and replenishment settings for this driver.`, owner: 'Category Manager' }),
    CX: (d) => ({ title: `Coach on ${d.key}`, body: `Pipeline movement of ${fmt(Math.abs(d.variance))}. Review stale opportunities and close-date discipline for this driver.`, owner: 'Sales Manager' }),
    XFN: (d) => ({ title: `Escalate ${d.key}`, body: `Cross-functional movement of ${fmt(Math.abs(d.variance))}. Route to the owning domain dashboard for detail.`, owner: 'Group Performance Office' })
  };
  const make = templates[domain] || templates.XFN;
  return drivers.slice(0, 3).map((d) => ({ ...make(d), advisory: true }));
}
