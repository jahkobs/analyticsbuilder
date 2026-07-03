'use strict';

import { DOMAINS, ROLES, VIEWS, DRILL_HIERARCHIES, OAC_TEMPLATES, PROMPT_LIBRARY } from './catalog.js';
import { validateSql, DEFAULT_ROW_LIMIT } from './guardrail.js';
import { planPrompt } from './promptEngine.js';
import { buildDashboard, renderDashboard } from './dashboard.js';
import { hideTip } from './charts.js';
import { dataFreshness, ENTERPRISE, LAST_REFRESH } from './data.js';
import {
  testAdw, testOac, testGateway, testAi, adwDictionary, profileTable,
  executeWorkbenchSql, sessionSecrets, AI_PROVIDERS
} from './connections.js';

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
    adw: { host: '', serviceName: '', access: 'readonly', walletFileName: '', username: 'INNOVATIA_RO_SVC' },
    oac: { url: '', catalogRoot: '/Shared Folders/Custom', username: '' },
    ai: { provider: 'gateway', username: '', model: '' },
    gateway: { url: 'https://gateway.innovatia.example', timeoutS: 60 },
    rowLimit: DEFAULT_ROW_LIMIT
  },
  // Connection test results for this session (never persisted).
  conn: { adw: null, oac: null, ai: null }
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
  { id: 'workbench', label: 'SQL Workbench', icon: '❯_' },
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
         applies ownership and ACLs, and records the release. On approval the dashboard is <b>deployed directly into
         ${escapeHtml(state.settings.oac.url || 'the configured OAC instance')}</b>${state.conn.oac?.ok ? '' : ' — test the OAC connection under Connections first for live deployments'}.</p>
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
            ${r.releasedAt ? `<span><b>Released & deployed</b>${new Date(r.releasedAt).toLocaleString('en-GB')}</span>` : ''}
            ${r.deployedTo ? `<span><b>OAC instance</b><code>${escapeHtml(r.deployedTo)}</code></span>` : ''}
          </div>
          ${r.status === 'Released' && r.deployedTo && r.deployedTo.startsWith('https://') && !r.deployedTo.includes('(demo)')
      ? `<div class="release-open"><a href="${escapeHtml(r.deployedTo)}" target="_blank" rel="noopener">Open in Oracle Analytics Cloud ↗</a></div>` : ''}
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
    b.disabled = true;
    b.textContent = 'Deploying to OAC…';
    // Approval triggers the deployment: the gateway copies the approved
    // template into the shared catalog on the configured OAC instance,
    // binds the dataset and applies ACLs (§11.2 steps 4–7).
    const target = state.settings.oac.url || 'https://oac-innovatia.analytics.ocp.oraclecloud.com (demo)';
    await new Promise((r) => setTimeout(r, state.settings.mode === 'demo' ? 900 : 100));
    rel.status = 'Released';
    rel.approver = state.user;
    rel.releasedAt = new Date().toISOString();
    rel.deployedTo = target;
    await bridge.saveReleases(state.releases);
    audit('oac.publish.approve', { release: rel.id, catalogPath: rel.catalogPath });
    audit('oac.deploy', { release: rel.id, target, catalogPath: rel.catalogPath });
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

// ---------- Screen: Connections ----------

function connStatusHtml(result) {
  if (!result) return '';
  return `<div class="conn-result ${result.ok ? 'conn-ok' : 'conn-fail'}">
    ${result.ok ? '✓' : '✗'} ${escapeHtml(result.detail)}
    ${result.warning ? `<div class="conn-warn">⚠ ${escapeHtml(result.warning)}</div>` : ''}
  </div>`;
}

async function runConnTest(kind, root) {
  const btn = $(`#test-${kind}`, root);
  btn.disabled = true;
  btn.textContent = 'Testing…';
  const fn = { adw: testAdw, oac: testOac, ai: testAi }[kind];
  const result = await fn({ settings: state.settings, bridge });
  state.conn[kind] = { ...result, at: new Date().toISOString() };
  audit(`connection.test.${kind}`, {
    ok: result.ok, mode: state.settings.mode,
    provider: kind === 'ai' ? state.settings.ai.provider : undefined,
    access: kind === 'adw' ? state.settings.adw.access : undefined
  });
  renderSettings($('#screen'));
}

function collectSettingsForm(root) {
  const s = state.settings;
  s.mode = root.querySelector('input[name=mode]:checked')?.value || s.mode;
  s.adw.access = root.querySelector('input[name=adw-access]:checked')?.value || s.adw.access;
  s.adw.host = $('#set-adw-host', root)?.value ?? s.adw.host;
  s.adw.serviceName = $('#set-adw-service', root)?.value ?? s.adw.serviceName;
  s.adw.username = $('#set-adw-user', root)?.value ?? s.adw.username;
  s.oac.url = $('#set-oac-url', root)?.value ?? s.oac.url;
  s.oac.catalogRoot = $('#set-oac-root', root)?.value ?? s.oac.catalogRoot;
  s.oac.username = $('#set-oac-user', root)?.value ?? s.oac.username;
  s.ai.provider = $('#set-ai-provider', root)?.value ?? s.ai.provider;
  s.ai.username = $('#set-ai-user', root)?.value ?? s.ai.username;
  s.ai.model = $('#set-ai-model', root)?.value ?? s.ai.model;
  s.gateway.url = $('#set-gw-url', root)?.value ?? s.gateway.url;
  s.gateway.timeoutS = Number($('#set-gw-timeout', root)?.value) || s.gateway.timeoutS;
  s.rowLimit = Number($('#set-rowlimit', root)?.value) || s.rowLimit;
  // Secrets stay in memory only.
  sessionSecrets.adwPassword = $('#set-adw-pass', root)?.value ?? sessionSecrets.adwPassword;
  sessionSecrets.oacPassword = $('#set-oac-pass', root)?.value ?? sessionSecrets.oacPassword;
  sessionSecrets.aiKey = $('#set-ai-key', root)?.value ?? sessionSecrets.aiKey;
}

function renderSettings(root) {
  const s = state.settings;
  const provider = AI_PROVIDERS.find((p) => p.id === s.ai.provider) || AI_PROVIDERS[0];
  const adwOk = state.conn.adw?.ok;
  root.innerHTML = `
    <h1>Connections & environment</h1>
    <p class="muted">Passwords, API keys and the wallet are held in memory for this session only — they are never
       written to disk or the installer. Production deployments register secrets in OCI Vault (§12.3).</p>
    <div class="settings-grid">
      <section class="gov-panel">
        <h2>Execution mode</h2>
        <label class="radio-row"><input type="radio" name="mode" value="demo" ${s.mode === 'demo' ? 'checked' : ''}/> Demo data (offline) — synthetic dataset, full journey, no connection required</label>
        <label class="radio-row"><input type="radio" name="mode" value="live" ${s.mode === 'live' ? 'checked' : ''}/> Live — execute against the configured endpoints (authenticated HTTPS)</label>
      </section>

      <section class="gov-panel">
        <h2>InnovatIA AI Gateway & limits</h2>
        <label>Gateway URL<input id="set-gw-url" value="${escapeHtml(s.gateway.url)}"/></label>
        <label>Query timeout (seconds)<input id="set-gw-timeout" type="number" value="${s.gateway.timeoutS}"/></label>
        <label>Row limit per query<input id="set-rowlimit" type="number" value="${s.rowLimit}"/></label>
      </section>

      <section class="gov-panel">
        <h2>Oracle ADW</h2>
        <div class="access-row">
          <span class="muted small">Access mode</span>
          <label class="radio-row"><input type="radio" name="adw-access" value="readonly" ${s.adw.access !== 'write' ? 'checked' : ''}/> Read-only (recommended — dashboard & AI execution)</label>
          <label class="radio-row"><input type="radio" name="adw-access" value="write" ${s.adw.access === 'write' ? 'checked' : ''}/> Read-write (data-engineering pipeline account)</label>
          ${s.adw.access === 'write' ? '<div class="conn-warn">⚠ §12.3: dashboards and the AI planner must run on a read-only account. Read-write is reserved for the SQL Workbench engineering lane.</div>' : ''}
        </div>
        <label>Host / TNS descriptor<input id="set-adw-host" value="${escapeHtml(s.adw.host)}" placeholder="adb.eu-frankfurt-1.oraclecloud.com"/></label>
        <label>Service name<input id="set-adw-service" value="${escapeHtml(s.adw.serviceName)}" placeholder="innovatia_low"/></label>
        <label>Database wallet (mTLS)
          <span class="file-row">
            <button id="adw-wallet-browse" class="ghost-btn">Browse…</button>
            <span id="adw-wallet-name" class="file-name">${escapeHtml((sessionSecrets.walletPath || s.adw.walletFileName || '').split(/[\\/]/).pop() || 'No wallet selected')}</span>
          </span>
        </label>
        <label>Username<input id="set-adw-user" value="${escapeHtml(s.adw.username)}" autocomplete="off"/></label>
        <label>Password<input id="set-adw-pass" type="password" value="${escapeHtml(sessionSecrets.adwPassword)}" placeholder="session only — not saved" autocomplete="new-password"/></label>
        <div class="test-row"><button id="test-adw" class="primary-btn">Test connection</button></div>
        ${connStatusHtml(state.conn.adw)}
      </section>

      <section class="gov-panel">
        <h2>Oracle Analytics Cloud</h2>
        <label>OAC instance URL<input id="set-oac-url" value="${escapeHtml(s.oac.url)}" placeholder="https://oac-innovatia.analytics.ocp.oraclecloud.com"/></label>
        <label>Shared catalog root<input id="set-oac-root" value="${escapeHtml(s.oac.catalogRoot)}"/></label>
        <label>Username<input id="set-oac-user" value="${escapeHtml(s.oac.username)}" placeholder="oac.publisher@innovatia.example" autocomplete="off"/></label>
        <label>Password<input id="set-oac-pass" type="password" value="${escapeHtml(sessionSecrets.oacPassword)}" placeholder="session only — not saved" autocomplete="new-password"/></label>
        <div class="test-row"><button id="test-oac" class="primary-btn">Test connection</button></div>
        ${connStatusHtml(state.conn.oac)}
        <p class="muted small">Approved dashboards deploy directly into this instance from the OAC Publications screen.</p>
      </section>

      <section class="gov-panel">
        <h2>AI connection</h2>
        <label>Provider
          <select id="set-ai-provider">
            ${AI_PROVIDERS.map((p) => `<option value="${p.id}" ${p.id === s.ai.provider ? 'selected' : ''}>${p.label}</option>`).join('')}
          </select>
        </label>
        ${provider.id !== 'gateway' ? `
          <label>${provider.accountLabel}<input id="set-ai-user" value="${escapeHtml(s.ai.username)}" placeholder="you@innovatia.example" autocomplete="off"/></label>
          <label>${provider.keyLabel}<input id="set-ai-key" type="password" value="${escapeHtml(sessionSecrets.aiKey)}" placeholder="session only — not saved" autocomplete="new-password"/></label>
          <label>Model<input id="set-ai-model" value="${escapeHtml(s.ai.model || provider.defaultModel)}"/></label>
        ` : ''}
        <p class="muted small">${provider.note}</p>
        <div class="test-row"><button id="test-ai" class="primary-btn">Test connection</button></div>
        ${connStatusHtml(state.conn.ai)}
      </section>
    </div>

    <div class="settings-actions">
      <button id="set-save" class="primary-btn">Save settings</button>
      <span id="set-msg" class="muted"></span>
    </div>

    <section id="schema-browser"></section>`;

  root.querySelectorAll('input[name=adw-access], #set-ai-provider').forEach((el) =>
    el.addEventListener('change', () => { collectSettingsForm(root); renderSettings(root); }));

  $('#adw-wallet-browse', root).addEventListener('click', async () => {
    collectSettingsForm(root);
    if (bridge.pickFile) {
      const res = await bridge.pickFile({ title: 'Select ADW wallet', filters: [{ name: 'Wallet', extensions: ['zip', 'sso', 'p12', 'jks'] }] });
      if (res.ok) {
        sessionSecrets.walletPath = res.filePath;
        state.settings.adw.walletFileName = res.filePath.split(/[\\/]/).pop();
        renderSettings(root);
      }
    } else {
      // Browser preview fallback
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.zip,.sso,.p12,.jks';
      input.addEventListener('change', () => {
        if (input.files[0]) {
          sessionSecrets.walletPath = input.files[0].name;
          state.settings.adw.walletFileName = input.files[0].name;
          renderSettings(root);
        }
      });
      input.click();
    }
  });

  for (const kind of ['adw', 'oac', 'ai']) {
    $(`#test-${kind}`, root)?.addEventListener('click', () => { collectSettingsForm(root); runConnTest(kind, root); });
  }

  $('#set-save', root).addEventListener('click', async () => {
    collectSettingsForm(root);
    await bridge.saveSettings(state.settings);
    audit('settings.save', { mode: s.mode, adwHost: s.adw.host, adwAccess: s.adw.access, oacUrl: s.oac.url, aiProvider: s.ai.provider });
    $('#set-msg', root).textContent = ' Saved (no secrets persisted).';
    renderShell();
    renderSettings($('#screen'));
  });

  renderSchemaBrowser($('#schema-browser', root), adwOk);
}

// ---------- ADW schema & table browser ----------

let browserState = { schema: 'INNOVATIA_RPT', search: '', selected: null };

function renderSchemaBrowser(container, adwOk) {
  if (!container) return;
  if (!adwOk) {
    container.innerHTML = `<div class="browser-locked muted">
      🔒 The schema browser unlocks after a successful <b>Oracle ADW</b> connection test above.</div>`;
    return;
  }
  const dict = adwDictionary();
  const schema = dict.find((d) => d.schema === browserState.schema) || dict[0];
  const tables = schema.tables.filter((t) =>
    !browserState.search || t.name.toLowerCase().includes(browserState.search) || (t.comment || '').toLowerCase().includes(browserState.search));
  const sel = browserState.selected ? schema.tables.find((t) => t.name === browserState.selected) : null;
  const profile = sel ? profileTable(sel) : null;

  container.innerHTML = `
    <h2 class="browser-title">ADW schema browser</h2>
    <p class="muted">Connected as <code>${escapeHtml(state.settings.adw.username)}</code> — dictionary served from ALL_TABLES/ALL_TAB_COLUMNS via the gateway.
       Dashboards can only be built on the exposed <code>INNOVATIA_RPT</code> semantic layer.</p>
    <div class="browser-grid">
      <nav class="browser-schemas">
        ${dict.map((d) => `<button class="schema-item ${d.schema === schema.schema ? 'active' : ''}" data-s="${d.schema}">
          <b>${d.schema}</b><span>${d.tables.length} objects${d.exposed ? ' · exposed' : ''}</span></button>`).join('')}
      </nav>
      <div class="browser-tables">
        <input id="browser-search" type="search" placeholder="Filter tables & views…" value="${escapeHtml(browserState.search)}"/>
        <div class="browser-note muted small">${escapeHtml(schema.description)}</div>
        <div class="table-list">
          ${tables.map((t) => `<button class="table-item ${sel?.name === t.name ? 'active' : ''}" data-t="${t.name}">
            <code>${t.name}</code><span>${t.type} · ~${t.rows.toLocaleString('en-GB')} rows${t.secure ? ' · 🔒' : ''}</span></button>`).join('') || '<p class="muted">No matches.</p>'}
        </div>
      </div>
      <div class="browser-detail">
        ${sel ? `
          <h3><code>${sel.name}</code>${sel.secure ? ' <span class="secure-flag">🔒 secure</span>' : ''}</h3>
          <p class="muted">${escapeHtml(sel.comment || '')}</p>
          <div class="cat-cols"><b>Columns (${sel.columns.length})</b>${sel.columns.map((c) => `<code>${c}</code>`).join(' ') || '<span class="muted">—</span>'}</div>
          ${profile ? `
            <div class="profile-card">
              <div class="profile-head">Data insight profile</div>
              <ul>${profile.insight.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
              <button id="build-from-table" class="primary-btn">Build “${profile.recommendedDashboard}” from this table</button>
              <div class="muted small">The dashboard is seeded from this view's detected measures, dimensions, grain and freshness.</div>
            </div>` : `
            <div class="profile-card profile-blocked">
              <div class="profile-head">Not exposed to dashboards</div>
              <p class="muted small">Only governed <code>RPT_*</code>/<code>SEC_*</code> reporting views may feed dashboards and OAC (§2.1).
                 Promote this data through the semantic layer and register it in the catalogue first.</p>
            </div>`}`
    : '<p class="muted">Select a table or view to inspect its contract and data insight profile.</p>'}
      </div>
    </div>`;

  container.querySelectorAll('.schema-item').forEach((b) => b.addEventListener('click', () => {
    browserState = { ...browserState, schema: b.dataset.s, selected: null };
    audit('adw.browse.schema', { schema: b.dataset.s });
    renderSchemaBrowser(container, true);
  }));
  container.querySelectorAll('.table-item').forEach((b) => b.addEventListener('click', () => {
    browserState.selected = b.dataset.t;
    audit('adw.browse.table', { schema: schema.schema, table: b.dataset.t });
    renderSchemaBrowser(container, true);
  }));
  const search = $('#browser-search', container);
  search.addEventListener('input', () => {
    browserState.search = search.value.toLowerCase();
    renderSchemaBrowser(container, true);
    const s2 = $('#browser-search', container);
    s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length);
  });
  $('#build-from-table', container)?.addEventListener('click', () => {
    audit('dashboard.generate.fromTable', { table: sel.name, intent: profile.intentId });
    state.dashboard = { intentId: profile.intentId, scope: {}, drill: { path: [] } };
    navigate('dashboard');
  });
}

// ---------- Screen: SQL Workbench ----------

function renderWorkbench(root) {
  const s = state.settings;
  const engineeringAllowed = state.role.canAdmin && s.adw.access === 'write';
  root.innerHTML = `
    <h1>SQL Workbench</h1>
    <p class="muted">Query the ADW database directly. All roles run governed <b>SELECT</b> statements (same guardrail as the AI planner).
       <b>DDL/DML</b> runs on the engineering lane: Platform Administrator role + a read-write ADW connection. Every statement is audited.</p>
    <div class="wb-lane ${engineeringAllowed ? 'wb-lane-write' : 'wb-lane-read'}">
      ${engineeringAllowed
      ? '⚠ Engineering lane active: read-write connection as Platform Administrator — DDL and DML are permitted and audited.'
      : `Governed lane: SELECT-only. ${state.role.canAdmin ? 'Switch the ADW connection to read-write to enable DDL/DML.' : 'DDL/DML requires the Platform Administrator role and a read-write connection.'}`}
    </div>
    <textarea id="wb-sql" rows="7" spellcheck="false" placeholder="SELECT supplier_name, SUM(outstanding_amt) FROM RPT_FIN_AP_AGEING_V GROUP BY supplier_name ORDER BY 2 DESC">${state.wbSql || ''}</textarea>
    <div class="wb-actions">
      <button id="wb-run" class="primary-btn">Run statement</button>
      <span class="muted small">Row limit ${s.rowLimit} · timeout ${s.gateway.timeoutS}s · ${s.mode === 'demo' ? 'demo dataset' : 'live via gateway'}</span>
    </div>
    <div id="wb-result"></div>`;

  const run = async () => {
    const sql = $('#wb-sql', root).value;
    state.wbSql = sql;
    if (!sql.trim()) return;
    const btn = $('#wb-run', root);
    btn.disabled = true; btn.textContent = 'Running…';
    const res = await executeWorkbenchSql(sql, { role: state.role, settings: s });
    audit('workbench.execute', { kind: res.kind, lane: res.lane, ok: res.ok, sql: sql.slice(0, 300) });
    btn.disabled = false; btn.textContent = 'Run statement';
    const target = $('#wb-result', root);
    if (!res.ok) {
      target.innerHTML = `<div class="guard-verdict sql-bad">✗ Statement rejected</div>
        ${res.errors.map((e) => `<div class="sql-err">• ${escapeHtml(e)}</div>`).join('')}`;
      return;
    }
    target.innerHTML = `
      <div class="guard-verdict sql-ok">✓ ${escapeHtml(res.message)}</div>
      ${res.warning ? `<div class="sql-warn">• ${escapeHtml(res.warning)}</div>` : ''}
      ${(res.warnings || []).map((w) => `<div class="sql-warn">• ${escapeHtml(w)}</div>`).join('')}
      ${res.rows?.length ? `<div class="wb-table-wrap"><table class="detail-table">
        <thead><tr>${res.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
        <tbody>${res.rows.slice(0, 100).map((r) => `<tr>${res.columns.map((c) =>
        `<td class="${typeof r[c] === 'number' ? 'num' : ''}">${escapeHtml(String(r[c] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>${res.rows.length > 100 ? `<div class="table-note">Showing 100 of ${res.rows.length} fetched rows.</div>` : ''}</div>` : ''}`;
  };
  $('#wb-run', root).addEventListener('click', run);
  $('#wb-sql', root).addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run();
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
    workbench: renderWorkbench,
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
  if (saved) {
    state.settings = {
      ...state.settings, ...saved,
      adw: { ...state.settings.adw, ...saved.adw },
      oac: { ...state.settings.oac, ...saved.oac },
      ai: { ...state.settings.ai, ...saved.ai },
      gateway: { ...state.settings.gateway, ...saved.gateway }
    };
  }

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
