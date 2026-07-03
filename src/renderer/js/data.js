'use strict';

// ---------------------------------------------------------------------------
// Demo-mode dataset service.
//
// In "Demo (offline)" mode the gateway resolves validated queries against a
// deterministic, seeded synthetic dataset so the full prompt → guardrail →
// dashboard → drill → publish journey can be exercised without an ADW
// connection. In "Live" mode the same requests are sent to the InnovatIA
// gateway over authenticated HTTPS (endpoint configured in Settings).
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashCode(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(key) { return mulberry32(hashCode(key)); }

export const ENTERPRISE = {
  group: 'InnovatIA Group',
  reportingCurrency: 'GHS',
  clusters: [
    {
      name: 'West Africa Cluster',
      companies: [
        { name: 'InnovatIA Ghana', currency: 'GHS', scale: 1.0, businessUnits: ['Accra Commercial', 'Accra Industrial', 'Takoradi Services'] },
        { name: 'InnovatIA Nigeria', currency: 'NGN', scale: 1.35, businessUnits: ['Lagos Commercial', 'Abuja Services', 'Port Harcourt Industrial'] }
      ]
    },
    {
      name: 'East Africa Cluster',
      companies: [
        { name: 'InnovatIA Kenya', currency: 'KES', scale: 0.7, businessUnits: ['Nairobi Commercial', 'Mombasa Logistics'] },
        { name: 'InnovatIA Tanzania', currency: 'TZS', scale: 0.45, businessUnits: ['Dar es Salaam Commercial'] }
      ]
    }
  ],
  costCentres: ['Transport', 'Sales & Distribution', 'Manufacturing', 'Administration', 'IT & Digital', 'Facilities', 'Marketing'],
  naturalAccounts: [
    { code: '4100', name: 'Product Revenue', class: 'Revenue' },
    { code: '4200', name: 'Service Revenue', class: 'Revenue' },
    { code: '5100', name: 'Cost of Goods Sold', class: 'Operating Cost' },
    { code: '5200', name: 'Freight & Transport', class: 'Operating Cost' },
    { code: '5300', name: 'Staff Costs', class: 'Operating Cost' },
    { code: '5400', name: 'Repairs & Maintenance', class: 'Operating Cost' },
    { code: '5500', name: 'Professional Fees', class: 'Operating Cost' },
    { code: '5600', name: 'Utilities & Energy', class: 'Operating Cost' }
  ],
  suppliers: [
    { name: 'Volta Logistics Ltd', category: 'Transport & Freight' },
    { name: 'Sahel Packaging Co', category: 'Packaging' },
    { name: 'Meridian Energy Plc', category: 'Utilities & Energy' },
    { name: 'Kwame Industrial Supplies', category: 'MRO & Spares' },
    { name: 'BlueWave IT Services', category: 'IT & Professional' },
    { name: 'Savannah Agro Traders', category: 'Raw Materials' },
    { name: 'Harmattan Facilities Mgt', category: 'Facilities' },
    { name: 'Zenith Print & Media', category: 'Marketing' }
  ],
  customers: [
    { name: 'Coastal Retail Group', group: 'Retail & Wholesale' },
    { name: 'Unity Supermarkets', group: 'Retail & Wholesale' },
    { name: 'Golden Fields FMCG', group: 'FMCG' },
    { name: 'Metro Construction Ltd', group: 'Construction' },
    { name: 'Equator Hotels Group', group: 'Hospitality' },
    { name: 'Northern Mining Corp', group: 'Mining & Industry' },
    { name: 'Lakeside Pharma', group: 'Healthcare' },
    { name: 'TransAfrica Distributors', group: 'Retail & Wholesale' }
  ],
  items: [
    { number: 'ITM-1001', description: 'Bottled Water 500ml (24-pack)', category: 'Beverages' },
    { number: 'ITM-1002', description: 'Sparkling Drink 330ml (12-pack)', category: 'Beverages' },
    { number: 'ITM-2001', description: 'Maize Flour 25kg', category: 'Food Staples' },
    { number: 'ITM-2002', description: 'Rice Long-Grain 50kg', category: 'Food Staples' },
    { number: 'ITM-3001', description: 'Detergent Powder 5kg', category: 'Home Care' },
    { number: 'ITM-3002', description: 'Liquid Soap 1L', category: 'Home Care' },
    { number: 'ITM-4001', description: 'PET Preforms 28mm', category: 'Packaging Inputs' },
    { number: 'ITM-4002', description: 'Carton Sleeves Std', category: 'Packaging Inputs' }
  ],
  departments: ['Finance', 'Operations', 'Sales', 'Supply Chain', 'Human Resources', 'IT & Digital', 'Customer Service'],
  grades: ['G1 Executive', 'G2 Senior Manager', 'G3 Manager', 'G4 Specialist', 'G5 Officer', 'G6 Operative'],
  salesOwners: ['A. Mensah', 'C. Okafor', 'D. Wanjiku', 'E. Boateng', 'F. Adeyemi', 'J. Mwangi', 'K. Asante', 'N. Eze'],
  salesStages: ['Qualification', 'Discovery', 'Solution', 'Proposal', 'Negotiation', 'Closing'],
  absencePlans: ['Annual Leave', 'Sick Leave', 'Compassionate Leave', 'Study Leave'],
  banks: ['Ecobank', 'Stanbic', 'Absa', 'GCB Bank', 'Zenith Bank']
};

export function companies() {
  return ENTERPRISE.clusters.flatMap((cl) =>
    cl.companies.map((c) => ({ ...c, cluster: cl.name })));
}

export const MONTHS = (() => {
  // 24 accounting periods ending at the current month.
  const out = [];
  const now = new Date();
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleString('en-GB', { month: 'short', year: '2-digit' }),
      periodName: `${d.toLocaleString('en-GB', { month: 'short' })}-${String(d.getFullYear()).slice(2)}`,
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      date: d
    });
  }
  return out;
})();

export const LAST_REFRESH = (() => {
  const d = new Date();
  d.setHours(5, 12, 0, 0);
  return d;
})();

// Baseline monthly revenue for the whole group, in GHS millions.
const GROUP_BASE = 42_000_000;

function seasonal(monthIndex) {
  return 1 + 0.12 * Math.sin(((monthIndex % 12) / 12) * Math.PI * 2) + (monthIndex * 0.006);
}

/** Monthly financials by company × cost centre × natural account. */
export function glSeries() {
  const rows = [];
  for (const co of companies()) {
    for (const cc of ENTERPRISE.costCentres) {
      for (const acct of ENTERPRISE.naturalAccounts) {
        const r = rng(`gl|${co.name}|${cc}|${acct.code}`);
        const isRevenue = acct.class === 'Revenue';
        const ccWeight = 0.06 + r() * 0.2;
        // Two revenue accounts vs six cost accounts: weight revenue so the
        // group runs at a plausible ~25% gross margin.
        const base = GROUP_BASE * co.scale * ccWeight * (isRevenue ? 1.12 : 0.28) / ENTERPRISE.costCentres.length;
        MONTHS.forEach((m, i) => {
          const noise = 0.9 + r() * 0.2;
          let actual = base * seasonal(i) * noise;
          // Plant a story: transport costs spike in the last two periods for
          // the largest company, so variance decomposition has real drivers.
          if (!isRevenue && cc === 'Transport' && co.name === 'InnovatIA Nigeria' && i >= MONTHS.length - 2) {
            actual *= 1.38;
          }
          const budget = base * seasonal(i) * (isRevenue ? 1.02 : 0.97);
          rows.push({
            period: m, cluster: co.cluster, company: co.name, businessUnit: co.businessUnits[Math.floor(r() * co.businessUnits.length)],
            costCentre: cc, accountCode: acct.code, accountName: acct.name, accountClass: acct.class,
            actual, budget, variance: actual - budget
          });
        });
      }
    }
  }
  return rows;
}

let _gl;
export function gl() { return (_gl ||= glSeries()); }

export function journalLines({ company, costCentre, accountName, period }) {
  const r = rng(`jrn|${company}|${costCentre}|${accountName}|${period?.key}`);
  const sources = ['Payables', 'Receivables', 'Manual', 'Spreadsheet', 'Assets', 'Inventory'];
  const rows = [];
  const n = 8 + Math.floor(r() * 8);
  for (let i = 0; i < n; i++) {
    const amt = Math.round((20000 + r() * 380000) * 100) / 100;
    rows.push({
      journal: `GL-${period?.key || '2026-06'}-${1000 + Math.floor(r() * 9000)}`,
      line: i + 1,
      date: `${period?.key || '2026-06'}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`,
      source: sources[Math.floor(r() * sources.length)],
      preparer: ['s.owusu', 'm.bello', 'k.njoroge', 'a.diallo'][Math.floor(r() * 4)],
      status: r() > 0.08 ? 'Posted' : 'Pending approval',
      debit: r() > 0.4 ? amt : 0,
      credit: r() > 0.4 ? 0 : amt,
      reference: `INV-${70000 + Math.floor(r() * 29999)}`
    });
  }
  return rows;
}

export function apAgeing() {
  const buckets = ['Current', '1-30 days', '31-60 days', '61-90 days', '90+ days'];
  const rows = [];
  for (const s of ENTERPRISE.suppliers) {
    const r = rng(`ap|${s.name}`);
    const base = 400000 + r() * 4200000;
    buckets.forEach((b, i) => {
      rows.push({
        supplier: s.name, category: s.category, bucket: b,
        outstanding: Math.round(base * [0.44, 0.26, 0.15, 0.09, 0.06][i] * (0.75 + r() * 0.5)),
        overdue: i > 0
      });
    });
  }
  return rows;
}

export function apInvoices(supplier) {
  const r = rng(`apinv|${supplier}`);
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const amt = Math.round(30000 + r() * 900000);
    const overdueDays = Math.floor(r() * 95);
    rows.push({
      invoice: `AP-${52000 + Math.floor(r() * 40000)}`,
      po: `PO-${8100 + Math.floor(r() * 1800)}`,
      supplier,
      amount: amt,
      dueDate: new Date(Date.now() - overdueDays * 86400000).toISOString().slice(0, 10),
      overdueDays,
      status: overdueDays > 0 ? 'Overdue' : 'Within terms',
      hold: r() > 0.85 ? 'Price hold' : ''
    });
  }
  return rows.sort((a, b) => b.overdueDays - a.overdueDays);
}

export function arAgeing() {
  const buckets = ['Current', '1-30 days', '31-60 days', '61-90 days', '90+ days'];
  const rows = [];
  for (const c of ENTERPRISE.customers) {
    const r = rng(`ar|${c.name}`);
    const base = 600000 + r() * 5200000;
    buckets.forEach((b, i) => {
      rows.push({
        customer: c.name, group: c.group, bucket: b,
        open: Math.round(base * [0.5, 0.24, 0.13, 0.08, 0.05][i] * (0.75 + r() * 0.5)),
        overdue: i > 0
      });
    });
  }
  return rows;
}

export function cashDaily() {
  const rows = [];
  for (const co of companies()) {
    for (const bank of ENTERPRISE.banks.slice(0, 3)) {
      const r = rng(`cash|${co.name}|${bank}`);
      let bal = 4_000_000 * co.scale * (0.6 + r() * 0.9);
      for (let d = 59; d >= 0; d--) {
        const date = new Date(Date.now() - d * 86400000);
        const inflow = 300000 * co.scale * r();
        const outflow = 290000 * co.scale * r();
        bal = Math.max(150000, bal + inflow - outflow);
        rows.push({ company: co.name, bank, date, closing: bal, inflow, outflow });
      }
    }
  }
  return rows;
}

export function workforce() {
  const rows = [];
  for (const co of companies()) {
    for (const dept of ENTERPRISE.departments) {
      const r = rng(`wf|${co.name}|${dept}`);
      const base = Math.round(40 * co.scale * (0.5 + r()));
      MONTHS.forEach((m, i) => {
        const drift = Math.round((r() - 0.45) * 4);
        const headcount = Math.max(6, base + Math.round(i * 0.4) + drift);
        rows.push({
          period: m, company: co.name, legalEmployer: co.name, department: dept,
          headcount,
          fte: Math.round(headcount * (0.92 + r() * 0.06) * 10) / 10,
          joiners: Math.max(0, Math.round(r() * 5)),
          leavers: Math.max(0, Math.round(r() * 4)),
          vacancies: Math.max(0, Math.round(r() * 6)),
          absenceRate: Math.round((2 + r() * 6) * 10) / 10,
          payrollCost: headcount * (5200 + r() * 2400)
        });
      });
    }
  }
  return rows;
}

export function spend() {
  const rows = [];
  for (const s of ENTERPRISE.suppliers) {
    for (const co of companies()) {
      const r = rng(`spend|${s.name}|${co.name}`);
      MONTHS.forEach((m, i) => {
        rows.push({
          period: m, supplier: s.name, category: s.category, company: co.name,
          businessUnit: co.businessUnits[Math.floor(r() * co.businessUnits.length)],
          spend: 90000 * co.scale * (0.4 + r()) * seasonal(i),
          committed: 110000 * co.scale * (0.4 + r()) * seasonal(i),
          onTimeDelivery: 78 + r() * 20,
          leadTime: 6 + r() * 18,
          exceptions: Math.floor(r() * 4)
        });
      });
    }
  }
  return rows;
}

export function inventory() {
  const rows = [];
  for (const item of ENTERPRISE.items) {
    for (const co of companies().slice(0, 3)) {
      const r = rng(`inv|${item.number}|${co.name}`);
      const onHand = Math.round(400 + r() * 8000);
      const daily = 30 + r() * 260;
      const dos = Math.round(onHand / daily * 10) / 10;
      rows.push({
        company: co.name, businessUnit: co.businessUnits[0],
        org: `${co.name.split(' ')[1]} DC1`,
        category: item.category, item: item.number, description: item.description,
        onHand,
        value: Math.round(onHand * (18 + r() * 90)),
        daysOfSupply: dos,
        stockoutRisk: dos < 7 ? 'High' : dos < 14 ? 'Medium' : 'Low',
        velocity: r() > 0.75 ? 'Slow' : r() > 0.15 ? 'Fast' : 'Non-moving'
      });
    }
  }
  return rows;
}

export function pipeline() {
  const rows = [];
  for (const owner of ENTERPRISE.salesOwners) {
    const r = rng(`pipe|${owner}`);
    const co = companies()[Math.floor(r() * 4)];
    for (let i = 0; i < 7; i++) {
      const stage = ENTERPRISE.salesStages[Math.floor(r() * ENTERPRISE.salesStages.length)];
      const amount = Math.round(120000 + r() * 2600000);
      const prob = { Qualification: 12, Discovery: 25, Solution: 42, Proposal: 60, Negotiation: 78, Closing: 90 }[stage];
      const daysSince = Math.floor(r() * 45);
      rows.push({
        cluster: co.cluster, company: co.name,
        businessUnit: co.businessUnits[Math.floor(r() * co.businessUnits.length)],
        owner,
        opportunity: `OPP-${3100 + Math.floor(r() * 6800)}`,
        customer: ENTERPRISE.customers[Math.floor(r() * ENTERPRISE.customers.length)].name,
        stage, amount, probability: prob,
        weighted: Math.round(amount * prob / 100),
        closeDate: new Date(Date.now() + Math.floor(r() * 120 - 20) * 86400000).toISOString().slice(0, 10),
        daysSinceActivity: daysSince,
        atRisk: daysSince > 21 || r() > 0.8
      });
    }
  }
  return rows;
}

export function cashConversion() {
  const rows = [];
  for (const co of companies()) {
    const r = rng(`ccc|${co.name}`);
    MONTHS.forEach((m, i) => {
      const dso = 38 + r() * 26 + (co.name === 'InnovatIA Nigeria' ? i * 0.35 : 0);
      const dpo = 44 + r() * 18;
      const dio = 30 + r() * 22;
      rows.push({ period: m, company: co.name, dso, dpo, dio, ccc: dso + dio - dpo });
    });
  }
  return rows;
}

export function dataFreshness() {
  const domains = [
    { domain: 'Finance', view: 'RPT_FIN_GL_BALANCE_PERIOD_V', ageH: 3.2, quality: 98.7 },
    { domain: 'Finance', view: 'RPT_FIN_CASH_DAILY_POSITION_V', ageH: 2.1, quality: 99.4 },
    { domain: 'HCM', view: 'RPT_HCM_WORKFORCE_SNAPSHOT_V', ageH: 4.6, quality: 97.2 },
    { domain: 'SCM', view: 'RPT_SCM_INVENTORY_POSITION_DAILY_V', ageH: 3.9, quality: 96.1 },
    { domain: 'CX', view: 'RPT_CX_OPPORTUNITY_PIPELINE_SNAPSHOT_V', ageH: 2.8, quality: 98.1 },
    { domain: 'XFN', view: 'RPT_XFN_CASH_CONVERSION_CYCLE_V', ageH: 8.4, quality: 95.3 }
  ];
  return domains.map((d) => ({
    ...d,
    batch: `BATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-01`,
    status: d.ageH < 6 ? 'Fresh' : 'Ageing'
  }));
}

export function formatMoney(v, { compact = true, currency = 'GHS' } = {}) {
  if (v == null || Number.isNaN(v)) return '—';
  const abs = Math.abs(v);
  if (compact) {
    if (abs >= 1e9) return `${currency} ${(v / 1e9).toFixed(1)}bn`;
    if (abs >= 1e6) return `${currency} ${(v / 1e6).toFixed(1)}m`;
    if (abs >= 1e3) return `${currency} ${(v / 1e3).toFixed(0)}k`;
    return `${currency} ${v.toFixed(0)}`;
  }
  return `${currency} ${v.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
}

export function formatNumber(v, dp = 0) {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toLocaleString('en-GB', { maximumFractionDigits: dp, minimumFractionDigits: 0 });
}
