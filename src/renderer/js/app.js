'use strict';

import { DOMAINS, ROLES, VIEWS, DRILL_HIERARCHIES, OAC_TEMPLATES, PROMPT_LIBRARY } from './catalog.js';
import { validateSql, DEFAULT_ROW_LIMIT } from './guardrail.js';
import { planPrompt } from './promptEngine.js';
import { buildDashboard, renderDashboard } from './dashboard.js';
import { hideTip } from './charts.js';
import { dataFreshness, ENTERPRISE, LAST_REFRESH } from './data.js';

// ---------------------------------------------------------------------------
// Application shell: navigation, role context, the end-to-end user journey
// (§12.1 Ask → Understand → Generate → Investigate → Save → Publish →
// Monitor), OAC release workflow and the audit trail.
// ---------------------------------------------------------------------------

// Persistence bridge: Electron preload when available, localStorage fallback
// so the renderer can also be exercised in a plain browser during testing.
const bridge = window.innovatia || {
  async appendAudit(e) {
    const log = JSON.parse(localStorage.getItem('audit') || '[]');
    log.push({ ...e, id: log.length + 1, recordedAt: new Date().toISOString() });
    localStorage.setItem('audit', JSON.stringify(log.slice(-5000)));
    return { ok: true };
  },
  async getAudit() { return JSON.parse(localStorage.getItem('audit') || '[]'); },
  async getDashboards() { return JSON.parse(localStorage.getItem('dashboards') || '[]'); },
  async saveDashboards(d) { localStorage.setItem('dashboards', JSON.stringify(d)); return { ok: true }; },
  async getReleases() { return JSON.parse(localStorage.getItem('releases') || '[]'); },
  async saveReleases(r) { localStorage.setItem('releases', JSON.stringify(r)); return { ok: true }; },
  async getSettings() { return JSON.parse(localStorage.getItem('settings') || 'null'); },
  async saveSettings(s) { localStorage.setItem('settings', JSON.stringify(s)); return { ok: true }; },
  async exportFile({ suggestedName, content }) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    a.download = suggestedName;
    a.click();
    return { ok: true };
  },
  async version() { return '1.0.0 (browser preview)'; }
};

const state = {
  role: ROLES.find((r) => r.id === 'analyst'),
  user: 'demo.analyst@innovatia.example',
  screen: 'ask',
  plan: null,
  dashboard: null, // { intentId, scope, drill }
  savedDashboards: [],
  releases: [],
  settings: {
    mode: 'demo',
    adw: { host: '', serviceName: '', walletRef: 'ocid1.vaultsecret…', username: 'INNOVATIA_RO_SVC' },
    oac: { url: '', catalogRoot: '/Shared Folders/Custom' },
    gateway: { url: 'https://gateway.innovatia.example', timeoutS: 60 },
    rowLimit: DEFAULT_ROW_LIMIT
  }
};

function audit(type, detail) {
  bridge.appendAudit({
    type,
    user: state.user,
    role: state.role.label,
    detail,
    at: new Date().toISOString()
  });
}

const $ = (sel, root = document) => root.querySelector(sel);

// ---------- Navigation ----------

const SCREENS = [
  { id: 'ask', label: 'Ask & Build', icon: '✦' },
  { id: 'dashboard', label: 'Dashboard Studio', icon: '▦' },
  { id: 'catalog', label: 'View Catalogue', icon: '☰' },
  { id: 'governance', label: 'Security & Governance', icon: '🛡' },
  { id: 'oac', label: 'OAC Publications', icon: '⇪' },
  { id: 'audit', label: 'Audit Trail', icon: '☲' },
  { id: 'settings', label: 'Connections', icon: '⚙' }
];

function navigate(id) {
  state.screen = id;
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.id === id));
  render();
}

function renderShell() {
  const app = $('#app');
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">◆</span>
        <span class="brand-name">InnovatIA <b>Analytics Builder</b></span>
        <span class="brand-tag">Governed AI · ADW reporting views · OAC publication</span>
      </div>
      <div class="topbar-right">
        <span class="conn-badge ${state.settings.mode === 'demo' ? 'conn-demo' : 'conn-live'}"
              title="${state.settings.mode === 'demo' ? 'Synthetic demo dataset — no ADW connection' : 'Connected via gateway'}">
          ${state.settings.mode === 'demo' ? '◌ Demo data (offline)' : '● Live · ADW read-only'}
        </span>
        <label class="role-picker">Role
          <select id="role-select">
            ${ROLES.map((r) => `<option value="${r.id}" ${r.id === state.role.id ? 'selected' : ''}>${r.label}</option>`).join('')}
          </select>
        </label>
        <button id="theme-toggle" class="ghost-btn" title="Toggle light/dark">◐</button>
      </div>
    </header>
    <div class="layout">
      <nav class="sidenav">
        ${SCREENS.map((s) => `<button class="nav-item ${s.id === state.screen ? 'active' : ''}" data-id="${s.id}">
          <span class="nav-icon">${s.icon}</span>${s.label}</button>`).join('')}
        <div class="sidenav-foot">
          <div>Read-only ADW service account</div>
          <div>All actions audited</div>
          <div id="app-version"></div>
        </div>
      </nav>
      <main id="screen" class="screen"></main>
    </div>`;

  document.querySelectorAll('.nav-item').forEach((n) => n.addEventListener('click', () => navigate(n.dataset.id)));
  $('#role-select').addEventListener('change', (e) => {
    state.role = ROLES.find((r) => r.id === e.target.value);
    audit('role.switch', { role: state.role.label });
    render();
  });
  $('#theme-toggle').addEventListener('click', () => {
    const root = document.documentElement;
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    localStorage.setItem('theme', next);
    render();
  });
  bridge.version().then((v) => { const el = $('#app-version'); if (el) el.textContent = `v${v}`; });
}

// ---------- Screen: Ask & Build ----------

function renderAsk(root) {
  const freshness = dataFreshness();
  root.innerHTML = `
    <div class="ask-hero">
      <h1>Ask a business question</h1>
      <p>InnovatIA resolves your terms through the governed glossary, proposes an approved dataset, filter,
         measure, visual and drill path — then generates validated, read-only SQL you can review before anything runs.</p>
      <div class="ask-input-row">
        <input id="prompt-input" type="text"
          placeholder="e.g. Show year-to-date revenue, operating cost and gross margin by company, with a monthly trend…" />
        <button id="prompt-go" class="primary-btn">Plan dashboard</button>
      </div>
      <div class="prompt-lib">
        <div class="lib-title">Approved prompt library</div>
        <div class="lib-chips">
          ${PROMPT_LIBRARY.map((p, i) => `<button class="chip chip-${p.domain.toLowerCase()}" data-i="${i}">
            <span class="chip-domain">${p.domain}</span>${p.text}</button>`).join('')}
        </div>
      </div>
    </div>
    <div id="plan-result"></div>
    <div class="fresh-strip">
      <div class="lib-title">Data trust — source freshness</div>
      <div class="fresh-cards">
        ${freshness.map((f) => `<div class="fresh-card">
          <div class="fresh-domain">${f.domain}</div>
          <div class="fresh-view">${f.view}</div>
          <div class="fresh-meta"><span class="fresh-dot ${f.status === 'Fresh' ? 'dot-good' : 'dot-warn'}"></span>${f.status} · ${f.ageH.toFixed(1)}h ago · quality ${f.quality}%</div>
        </div>`).join('')}
      </div>
    </div>`;

  const input = $('#prompt-input', root);
  const go = () => { if (input.value.trim()) handlePrompt(input.value.trim(), root); };
  $('#prompt-go', root).addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  root.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
    input.value = PROMPT_LIBRARY[Number(c.dataset.i)].text;
    go();
  }));
}

function handlePrompt(text, root) {
  const plan = planPrompt(text, { role: state.role });
  state.plan = plan;
  audit('prompt.plan', {
    prompt: text, intent: plan.intent.id, confidence: plan.confidence,
    primaryView: plan.intent.view, sqlValid: plan.validation.ok
  });

  const target = $('#plan-result', root || $('#screen'));
  const pct = Math.round(plan.confidence * 100);
  const it = plan.interpretation;
  target.innerHTML = `
    <div class="plan-card">
      <div class="plan-head">
        <h2>Interpretation ${plan.matched ? '' : '<span class="plan-warn">(low confidence — please confirm)</span>'}</h2>
        <span class="confidence-pill ${pct >= 80 ? 'conf-high' : pct >= 60 ? 'conf-med' : 'conf-low'}">Confidence ${pct}%</span>
      </div>
      <div class="plan-grid">
        <div><b>Dashboard</b>${it.dashboard}</div>
        <div><b>Domain</b>${DOMAINS[it.domain].label}</div>
        <div><b>Primary view</b><code>${it.primaryView}</code></div>
        <div><b>Period</b>${it.period}</div>
        <div><b>Scope</b>${it.companyScope}</div>
        <div><b>Currency</b>${it.currency}</div>
        <div class="plan-wide"><b>Drill route</b>${it.drillRoute}</div>
        <div class="plan-wide"><b>Visual plan</b>${it.visualPlan}</div>
      </div>
      ${plan.clarifications.length ? `<div class="plan-clarify">${plan.clarifications.map((c) => `<div>⚠ ${c}</div>`).join('')}</div>` : ''}
      <details class="sql-details" open>
        <summary>Generated SQL — ${plan.validation.ok
          ? '<span class="sql-ok">✓ passed guardrail validation (SELECT-only, approved views, row limit applied)</span>'
          : '<span class="sql-bad">✗ blocked by guardrail</span>'}</summary>
        <pre class="sql-block">${escapeHtml(plan.sql)}</pre>
        ${plan.validation.warnings.map((w) => `<div class="sql-warn">• ${w}</div>`).join('')}
        ${plan.validation.errors.map((e) => `<div class="sql-err">• ${e}</div>`).join('')}
      </details>
      <div class="plan-actions">
        <button id="plan-generate" class="primary-btn" ${plan.validation.ok ? '' : 'disabled'}>Generate dashboard preview</button>
        <button id="plan-refine" class="ghost-btn">Refine question</button>
      </div>
    </div>`;

  $('#plan-generate', target)?.addEventListener('click', () => {
    audit('dashboard.generate', { intent: plan.intent.id, scope: plan.scope.company || 'group' });
    state.dashboard = {
      intentId: plan.intent.id,
      scope: { company: plan.scope.company, period: plan.scope.period },
      drill: { path: [] }
    };
    navigate('dashboard');
  });
  $('#plan-refine', target)?.addEventListener('click', () => $('#prompt-input')?.focus());
}

// ---------- Screen: Dashboard studio ----------

function renderDashboardScreen(root) {
  if (!state.dashboard) {
    root.innerHTML = `<div class="empty-state">
      <h2>No dashboard yet</h2>
      <p>Plan one from <b>Ask & Build</b>, or open a saved definition below.</p>
      <div id="saved-list" class="saved-list"></div></div>`;
    renderSavedList($('#saved-list', root));
    return;
  }
  const { intentId, scope, drill } = state.dashboard;
  const model = buildDashboard(intentId, { scope, drill, role: state.role });

  const bar = document.createElement('div');
  bar.className = 'studio-bar';
  bar.innerHTML = `
    <div class="studio-note">Preview generated from governed views — SQL validated & audited.</div>
    <div class="studio-actions">
      <button id="dash-save" class="ghost-btn" ${state.role.canCreate ? '' : 'disabled title="Your role cannot save definitions"'}>Save definition</button>
      <button id="dash-publish" class="primary-btn" ${state.role.canPublish ? '' : 'disabled title="Your role cannot publish to OAC"'}>Publish to OAC…</button>
    </div>`;
  root.innerHTML = '';
  root.appendChild(bar);

  const host = document.createElement('div');
  root.appendChild(host);

  renderDashboard(host, model, {
    role: state.role,
    onDrill: (level, value) => {
      if (level === '__pop__') {
        state.dashboard.drill.path = value < 0 ? [] : state.dashboard.drill.path.slice(0, value + 1);
      } else {
        state.dashboard.drill.path.push({ level, value });
      }
      audit('dashboard.drill', { intent: intentId, path: state.dashboard.drill.path.map((p) => `${p.level}=${p.value}`) });
      renderDashboardScreen(root);
    },
    onAsk: (q) => {
      audit('prompt.contextual', { prompt: q, context: intentId });
      navigate('ask');
      requestAnimationFrame(() => {
        const input = $('#prompt-input');
        if (input) { input.value = q; handlePrompt(q); }
      });
    }
  });

  $('#dash-save', bar).addEventListener('click', async () => {
    const def = {
      id: `dash-${Date.now()}`,
      title: model.title,
      intentId, scope, drill: state.dashboard.drill,
      version: 1,
      owner: state.user,
      sourceViews: [model.view],
      classification: model.view.startsWith('SEC_') ? 'Restricted' : 'Internal',
      savedAt: new Date().toISOString()
    };
    state.savedDashboards.push(def);
    await bridge.saveDashboards(state.savedDashboards);
    audit('dashboard.save', { id: def.id, title: def.title, sourceViews: def.sourceViews });
    bar.querySelector('.studio-note').textContent = `Saved “${def.title}” (v${def.version}) — owner, source views and classification recorded.`;
  });

  $('#dash-publish', bar).addEventListener('click', () => openPublishModal(model));
}

function renderSavedList(container) {
  if (!container) return;
  if (!state.savedDashboards.length) { container.innerHTML = '<p class="muted">No saved definitions.</p>'; return; }
  container.innerHTML = state.savedDashboards.map((d) => `
    <button class="saved-item" data-id="${d.id}">
      <b>${d.title}</b><span>${d.classification} · saved ${new Date(d.savedAt).toLocaleString('en-GB')}</span>
    </button>`).join('');
  container.querySelectorAll('.saved-item').forEach((b) => b.addEventListener('click', () => {
    const def = state.savedDashboards.find((d) => d.id === b.dataset.id);
    state.dashboard = { intentId: def.intentId, scope: def.scope, drill: def.drill || { path: [] } };
    navigate('dashboard');
  }));
}

// ---------- OAC publication workflow (§11.2) ----------

function openPublishModal(model) {
  const templates = OAC_TEMPLATES.filter((t) => t.domain === model.domain);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Publish to Oracle Analytics Cloud</h2>
      <p class="muted">Template-led release: the gateway validates the definition, copies the approved catalog object,
         applies ownership and ACLs, and records the release. Publication requires approval before users see it.</p>
      <label>Dashboard name<input id="pub-name" type="text" value="${model.title} — ${ENTERPRISE.group}" /></label>
      <label>Approved template
        <select id="pub-template">
          ${templates.map((t) => `<option value="${t.id}">${t.label} · ${t.catalogPath}</option>`).join('')}
        </select>
      </label>
      <label>Access (OAC application roles)
        <select id="pub-acl" multiple size="3">
          <option selected>BI Consumer — ${DOMAINS[model.domain].label}</option>
          <option>BI Author — ${DOMAINS[model.domain].label}</option>
          <option>Executive Leadership</option>
        </select>
      </label>
      <div class="pub-checklist">
        <div>✓ Semantic model bound to <code>${model.view}</code> (approved RPT_/SEC_ views only)</div>
        <div>✓ Visual zones mapped: KPI · trend · driver · exception · detail · AI insight</div>
        <div>✓ Drill actions restricted to AI_DRILL_PATH_CATALOG entries</div>
        <div>✓ Row-level security & masking inherited from ADW</div>
      </div>
      <div class="modal-actions">
        <button id="pub-cancel" class="ghost-btn">Cancel</button>
        <button id="pub-submit" class="primary-btn">Submit for approval</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#pub-cancel', overlay).addEventListener('click', () => overlay.remove());
  $('#pub-submit', overlay).addEventListener('click', async () => {
    const template = templates.find((t) => t.id === $('#pub-template', overlay).value) || templates[0];
    const release = {
      id: `REL-${Date.now()}`,
      dashboardId: `dash-${Date.now()}`,
      name: $('#pub-name', overlay).value,
      template: template.label,
      catalogPath: `${template.catalogPath}/${$('#pub-name', overlay).value.replace(/[^\w ]/g, '').replace(/ +/g, '_')}`,
      semanticModelVersion: 'SM-2026.07-r3',
      sourceView: model.view,
      owner: state.user,
      acl: [...$('#pub-acl', overlay).selectedOptions].map((o) => o.textContent),
      status: 'Pending approval',
      requestedAt: new Date().toISOString(),
      approver: null,
      releasedAt: null
    };
    state.releases.push(release);
    await bridge.saveReleases(state.releases);
    audit('oac.publish.request', { release: release.id, name: release.name, catalogPath: release.catalogPath, template: release.template });
    overlay.remove();
    navigate('oac');
  });
}

function renderOac(root) {
  const canApprove = state.role.canApprove;
  root.innerHTML = `
    <h1>OAC publication & release records</h1>
    <p class="muted">Governed releases into the shared catalog (§11). Each record carries dashboard ID, source template,
       semantic-model version, owner, approver, catalog path and release timestamp.</p>
    ${state.releases.length ? '' : '<div class="empty-state"><p>No publication requests yet. Generate a dashboard and choose “Publish to OAC…”.</p></div>'}
    <div class="release-list">
      ${state.releases.map((r) => `
        <div class="release-card status-${r.status === 'Released' ? 'released' : r.status === 'Rejected' ? 'rejected' : 'pending'}">
          <div class="release-head"><b>${r.name}</b><span class="release-status">${r.status}</span></div>
          <div class="release-grid">
            <span><b>Release ID</b>${r.id}</span>
            <span><b>Template</b>${r.template}</span>
            <span><b>Catalog path</b><code>${r.catalogPath}</code></span>
            <span><b>Semantic model</b>${r.semanticModelVersion}</span>
            <span><b>Source view</b><code>${r.sourceView}</code></span>
            <span><b>Owner</b>${r.owner}</span>
            <span><b>ACL</b>${r.acl.join(' · ')}</span>
            <span><b>Requested</b>${new Date(r.requestedAt).toLocaleString('en-GB')}</span>
            ${r.approver ? `<span><b>Approver</b>${r.approver}</span>` : ''}
            ${r.releasedAt ? `<span><b>Released</b>${new Date(r.releasedAt).toLocaleString('en-GB')}</span>` : ''}
          </div>
          ${r.status === 'Pending approval' ? `
            <div class="release-actions">
              <button class="primary-btn rel-approve" data-id="${r.id}" ${canApprove ? '' : 'disabled title="Requires Dashboard Approver or Administrator role"'}>Approve & release</button>
              <button class="ghost-btn rel-reject" data-id="${r.id}" ${canApprove ? '' : 'disabled'}>Reject</button>
              ${canApprove && r.owner === state.user && state.role.id === 'approver' ? '<span class="sod-note">⚠ Segregation policy: approvers cannot approve their own sensitive dashboards.</span>' : ''}
            </div>` : ''}
        </div>`).join('')}
    </div>`;

  root.querySelectorAll('.rel-approve').forEach((b) => b.addEventListener('click', async () => {
    const rel = state.releases.find((r) => r.id === b.dataset.id);
    rel.status = 'Released';
    rel.approver = state.user;
    rel.releasedAt = new Date().toISOString();
    await bridge.saveReleases(state.releases);
    audit('oac.publish.approve', { release: rel.id, catalogPath: rel.catalogPath });
    renderOac(root);
  }));
  root.querySelectorAll('.rel-reject').forEach((b) => b.addEventListener('click', async () => {
    const rel = state.releases.find((r) => r.id === b.dataset.id);
    rel.status = 'Rejected';
    rel.approver = state.user;
    await bridge.saveReleases(state.releases);
    audit('oac.publish.reject', { release: rel.id });
    renderOac(root);
  }));
}

// ---------- Screen: View catalogue ----------

function renderCatalog(root) {
  root.innerHTML = `
    <h1>ADW reporting-view catalogue</h1>
    <p class="muted">The governed semantic layer: business-facing RPT_* views, secure SEC_* views and shared dimensions.
       Every view is a reporting contract with grain, lineage, owner, refresh and drill route (§2.2).</p>
    <div class="catalog-filters">
      <input id="cat-search" type="search" placeholder="Search views, grain, measures…" />
      ${Object.values(DOMAINS).map((d) => `<button class="chip cat-domain" data-d="${d.code}">${d.label}</button>`).join('')}
      <button class="chip cat-domain active" data-d="">All</button>
    </div>
    <div id="cat-list" class="catalog-list"></div>`;

  let domainFilter = '';
  const list = $('#cat-list', root);
  const draw = () => {
    const q = $('#cat-search', root).value.toLowerCase();
    const items = VIEWS.filter((v) =>
      (!domainFilter || v.domain === domainFilter) &&
      (!q || v.name.toLowerCase().includes(q) || v.grain.toLowerCase().includes(q) || v.measures.join(' ').includes(q)));
    list.innerHTML = items.map((v) => `
      <details class="cat-card">
        <summary>
          <span class="cat-name"><code>${v.name}</code>${v.secure ? ' <span class="secure-flag">🔒 secure</span>' : ''}</span>
          <span class="cat-domain-tag tag-${v.domain.toLowerCase()}">${DOMAINS[v.domain].label}</span>
        </summary>
        <div class="cat-body">
          <p>${v.grain}</p>
          <div class="cat-meta">
            <span><b>Owner</b>${v.owner}</span>
            <span><b>Refresh</b>${v.refresh}</span>
            <span><b>Drill hierarchy</b>${DRILL_HIERARCHIES.find((h) => h.id === v.drill)?.label || '—'}</span>
            <span><b>Lineage</b>DIM_*/FCT_* conformed model → ${v.name}</span>
          </div>
          ${v.measures.length ? `<div class="cat-cols"><b>Measures</b>${v.measures.map((m) => `<code>${m}</code>`).join(' ')}</div>` : ''}
          <div class="cat-cols"><b>Dimensions</b>${v.dims.map((m) => `<code>${m}</code>`).join(' ')}</div>
        </div>
      </details>`).join('');
  };
  $('#cat-search', root).addEventListener('input', draw);
  root.querySelectorAll('.cat-domain').forEach((b) => b.addEventListener('click', () => {
    domainFilter = b.dataset.d;
    root.querySelectorAll('.cat-domain').forEach((x) => x.classList.toggle('active', x === b));
    draw();
  }));
  draw();
}

// ---------- Screen: Security & governance ----------

function renderGovernance(root) {
  root.innerHTML = `
    <h1>Security & governance</h1>
    <div class="gov-grid">
      <section class="gov-panel">
        <h2>Role matrix (§12.2)</h2>
        <table class="detail-table">
          <thead><tr><th>Role</th><th>Create</th><th>Publish</th><th>Approve</th><th>Secure data</th><th>Audit</th></tr></thead>
          <tbody>${ROLES.map((r) => `<tr class="${r.id === state.role.id ? 'row-active' : ''}">
            <td><b>${r.label}</b><div class="muted small">${r.note}</div></td>
            <td>${r.canCreate ? '✓' : '—'}</td><td>${r.canPublish ? '✓' : '—'}</td>
            <td>${r.canApprove ? '✓' : '—'}</td><td>${r.canSeeSecure ? '✓' : 'masked'}</td>
            <td>${r.canSeeAudit ? '✓' : '—'}</td></tr>`).join('')}</tbody>
        </table>
      </section>
      <section class="gov-panel">
        <h2>Conformed drill hierarchies (§4.1)</h2>
        ${DRILL_HIERARCHIES.map((h) => `<div class="drill-row"><b>${h.label}</b><span>${h.route.join(' → ')}</span></div>`).join('')}
      </section>
      <section class="gov-panel gov-wide">
        <h2>SQL guardrail tester</h2>
        <p class="muted">Everything the AI drafts — and anything pasted here — is validated before execution:
           SELECT-only, approved views, no DDL/DML/PL-SQL, no database links, sensitive columns blocked, row limit enforced.</p>
        <textarea id="guard-sql" rows="5" spellcheck="false">SELECT company_name, SUM(closing_balance_amt) FROM RPT_FIN_GL_BALANCE_PERIOD_V GROUP BY company_name</textarea>
        <button id="guard-run" class="primary-btn">Validate</button>
        <div id="guard-result"></div>
      </section>
    </div>`;

  $('#guard-run', root).addEventListener('click', () => {
    const sql = $('#guard-sql', root).value;
    const res = validateSql(sql, { role: state.role, rowLimit: state.settings.rowLimit });
    audit('sql.validate', { ok: res.ok, errors: res.errors, manual: true });
    $('#guard-result', root).innerHTML = `
      <div class="guard-verdict ${res.ok ? 'sql-ok' : 'sql-bad'}">${res.ok ? '✓ Statement permitted' : '✗ Statement blocked by gateway'}</div>
      ${res.errors.map((e) => `<div class="sql-err">• ${e}</div>`).join('')}
      ${res.warnings.map((w) => `<div class="sql-warn">• ${w}</div>`).join('')}
      ${res.ok ? `<pre class="sql-block">${escapeHtml(res.sql)}</pre>` : ''}`;
  });
}

// ---------- Screen: Audit ----------

async function renderAudit(root) {
  if (!state.role.canSeeAudit) {
    root.innerHTML = `<div class="empty-state"><h2>Audit trail restricted</h2>
      <p>Only Platform Administrator and Internal Control / Audit roles may review the audit history.
         This access attempt has itself been logged.</p></div>`;
    audit('audit.access.denied', {});
    return;
  }
  const log = (await bridge.getAudit()).slice().reverse();
  root.innerHTML = `
    <h1>Audit trail</h1>
    <p class="muted">Every prompt, generated SQL, validation, drill action, save, publication request and approval (§12.3).
       <button id="audit-export" class="ghost-btn">Export JSON</button></p>
    <table class="detail-table audit-table">
      <thead><tr><th>#</th><th>When</th><th>User</th><th>Role</th><th>Event</th><th>Detail</th></tr></thead>
      <tbody>${log.slice(0, 200).map((e) => `<tr>
        <td>${e.id}</td><td>${new Date(e.recordedAt).toLocaleString('en-GB')}</td>
        <td>${e.user}</td><td>${e.role}</td><td><code>${e.type}</code></td>
        <td class="audit-detail">${escapeHtml(JSON.stringify(e.detail)).slice(0, 220)}</td></tr>`).join('')}</tbody>
    </table>`;
  $('#audit-export', root)?.addEventListener('click', async () => {
    await bridge.exportFile({ suggestedName: 'innovatia-audit-log.json', content: JSON.stringify(log, null, 2) });
    audit('audit.export', { rows: log.length });
  });
}

// ---------- Screen: Settings ----------

function renderSettings(root) {
  const s = state.settings;
  root.innerHTML = `
    <h1>Connections & environment</h1>
    <p class="muted">Credentials are never stored in this application or installer — supply OCI Vault secret references.
       Queries execute through the gateway with a read-only ADW service account (§12.3).</p>
    <div class="settings-grid">
      <section class="gov-panel">
        <h2>Execution mode</h2>
        <label class="radio-row"><input type="radio" name="mode" value="demo" ${s.mode === 'demo' ? 'checked' : ''}/> Demo data (offline) — synthetic dataset, full journey, no connection required</label>
        <label class="radio-row"><input type="radio" name="mode" value="live" ${s.mode === 'live' ? 'checked' : ''}/> Live — execute via InnovatIA AI Gateway (authenticated HTTPS)</label>
      </section>
      <section class="gov-panel">
        <h2>Oracle ADW (read-only)</h2>
        <label>Host / TNS descriptor<input id="set-adw-host" value="${s.adw.host}" placeholder="adb.eu-frankfurt-1.oraclecloud.com"/></label>
        <label>Service name<input id="set-adw-service" value="${s.adw.serviceName}" placeholder="innovatia_low"/></label>
        <label>Service account (read-only)<input id="set-adw-user" value="${s.adw.username}"/></label>
        <label>Vault secret reference (wallet & password)<input id="set-adw-wallet" value="${s.adw.walletRef}"/></label>
      </section>
      <section class="gov-panel">
        <h2>Oracle Analytics Cloud</h2>
        <label>OAC instance URL<input id="set-oac-url" value="${s.oac.url}" placeholder="https://oac-innovatia.analytics.ocp.oraclecloud.com"/></label>
        <label>Shared catalog root<input id="set-oac-root" value="${s.oac.catalogRoot}"/></label>
      </section>
      <section class="gov-panel">
        <h2>AI gateway & limits</h2>
        <label>Gateway URL<input id="set-gw-url" value="${s.gateway.url}"/></label>
        <label>Query timeout (seconds)<input id="set-gw-timeout" type="number" value="${s.gateway.timeoutS}"/></label>
        <label>Row limit per query<input id="set-rowlimit" type="number" value="${s.rowLimit}"/></label>
      </section>
    </div>
    <button id="set-save" class="primary-btn">Save settings</button>
    <span id="set-msg" class="muted"></span>`;

  $('#set-save', root).addEventListener('click', async () => {
    s.mode = root.querySelector('input[name=mode]:checked').value;
    s.adw.host = $('#set-adw-host', root).value;
    s.adw.serviceName = $('#set-adw-service', root).value;
    s.adw.username = $('#set-adw-user', root).value;
    s.adw.walletRef = $('#set-adw-wallet', root).value;
    s.oac.url = $('#set-oac-url', root).value;
    s.oac.catalogRoot = $('#set-oac-root', root).value;
    s.gateway.url = $('#set-gw-url', root).value;
    s.gateway.timeoutS = Number($('#set-gw-timeout', root).value) || 60;
    s.rowLimit = Number($('#set-rowlimit', root).value) || DEFAULT_ROW_LIMIT;
    await bridge.saveSettings(s);
    audit('settings.save', { mode: s.mode, adwHost: s.adw.host, oacUrl: s.oac.url });
    $('#set-msg', root).textContent = ' Saved (no secrets persisted).';
    renderShell(); render();
  });
}

// ---------- Render dispatcher ----------

function render() {
  hideTip();
  renderShell();
  const root = $('#screen');
  ({
    ask: renderAsk,
    dashboard: renderDashboardScreen,
    catalog: renderCatalog,
    governance: renderGovernance,
    oac: renderOac,
    audit: renderAudit,
    settings: renderSettings
  }[state.screen])(root);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- Boot ----------

(async function boot() {
  const savedTheme = localStorage.getItem('theme');
  document.documentElement.dataset.theme = savedTheme ||
    (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

  state.savedDashboards = await bridge.getDashboards() || [];
  state.releases = await bridge.getReleases() || [];
  const saved = await bridge.getSettings();
  if (saved) state.settings = { ...state.settings, ...saved, adw: { ...state.settings.adw, ...saved.adw }, oac: { ...state.settings.oac, ...saved.oac }, gateway: { ...state.settings.gateway, ...saved.gateway } };

  audit('session.start', { version: await bridge.version(), mode: state.settings.mode });
  render();

  // Deep link for automated tests: #screen=dashboard&intent=fin-exec
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get('intent')) {
    state.dashboard = { intentId: params.get('intent'), scope: {}, drill: { path: [] } };
    navigate('dashboard');
  } else if (params.get('screen')) {
    navigate(params.get('screen'));
  }
})();
