# InnovatIA Analytics Builder

Governed enterprise analytics **desktop application** for Oracle Fusion
Finance, HCM, Supply Chain and CX — implementing the *Enterprise ADW
Reporting View Catalogue, AI Dashboard Design and OAC Publication Blueprint*
(document v2.0).

The application turns approved business questions into secure ADW query
plans, interactive dashboard specifications, drill-down paths, insight
narratives and controlled Oracle Analytics Cloud releases.

## What's implemented (MVP acceptance criteria, blueprint §13.1)

| Capability | Where |
|---|---|
| Prompt-to-dashboard | **Ask & Build** — natural-language planner resolves domain, view, scope, period; drafts parameterised SQL; shows interpretation + confidence before anything runs (`src/renderer/js/promptEngine.js`) |
| Secure ADW querying | **SQL guardrail** — SELECT-only, approved `RPT_*`/`SEC_*` catalogue views only, DDL/DML/PL-SQL/db-links/unsafe packages rejected, sensitive columns blocked, row limit enforced (`src/renderer/js/guardrail.js`; interactive tester under *Security & Governance*) |
| Drill path | Company → cost centre → natural account → journal evidence, plus the six other conformed hierarchies (§4.1), restricted to catalogued routes |
| Advanced insight | Variance decomposition, least-squares forecast with confidence band, anomaly flags, §10.2-style narrative quoting only calculated drivers, advisory recommendation cards (`src/renderer/js/insights.js`) |
| OAC publication | Template-led release workflow: approved template + catalog path + ACLs → pending approval → on approval the dashboard is **deployed directly into the configured OAC instance**; full release record (dashboard ID, template, semantic-model version, owner, approver, path, target instance, timestamps) |
| Data trust | Every dashboard carries the governance footer: source view, data owner, refresh batch/status, quality %, security context, definition version |
| Audit | Every prompt, generated SQL, validation, drill, save, publication request and approval is logged; visible to Administrator / Internal Control roles only |
| Windows packaging | NSIS installer built by `electron-builder` (see below) |

The **ADW reporting-view catalogue** (64 views across Shared, Finance, HCM,
SCM, CX and Cross-Functional domains, each with grain, owner, refresh, drill
hierarchy, measures and dimensions per the §2.2 reporting-view contract)
lives in `src/renderer/js/catalog.js` and is the only surface the AI planner
and guardrail can reference — `RAW_*`/`STG_*`/`FCT_*` objects are never
exposed.

## Connections (all with Test connection buttons)

- **Oracle ADW** — read-only (dashboards/AI) or read-write (engineering)
  access modes, mTLS wallet file browser, username/password. After a
  successful test, the **ADW schema browser** unlocks: browse
  `INNOVATIA_RPT` / `_CORE` / `_STG` / `_RAW` schemas and tables, inspect
  columns and the per-table **data insight profile** (measures, dimensions,
  grain, row volume, refresh, quality), and build a dashboard directly from
  a governed table's insights.
- **Oracle Analytics Cloud** — instance URL, catalog root, username/password.
  Approved dashboards deploy straight into this instance.
- **AI connection** — the governed InnovatIA Gateway (recommended), or a
  simple connector for **Claude (Anthropic)** / **ChatGPT (OpenAI)** with
  account + API key. Every provider remains behind the SQL guardrail and
  audit trail.

Passwords, API keys and the wallet are held in memory for the session only —
never persisted to disk or the installer (§12.3: use OCI Vault in production).

## SQL Workbench

Query ADW directly. All roles run governed SELECTs (same guardrail as the AI
planner, secure-view masking included). **DDL/DML** executes on the
engineering lane, which requires the Platform Administrator role **and** a
read-write ADW connection; every statement is audited.

## Execution modes

- **Demo (offline)** — default. A deterministic synthetic dataset lets you
  exercise the entire journey (connect → browse schemas → ask/build →
  investigate → save → publish → deploy) with no connection.
- **Live** — the same requests execute against the configured gateway, ADW
  and OAC endpoints over authenticated HTTPS.

## Development

```bash
npm install          # add --ignore-scripts if your network blocks the Electron binary CDN
npm test             # 27 unit tests: guardrail, prompt planner, insights, catalogue contract
npm start            # launch the desktop app
```

## Building the Windows installer

CI (recommended): `.github/workflows/build-installer.yml` builds and tests on
`windows-latest` for every push to `main`/`claude/**` and on manual dispatch,
uploading `InnovatIA-Analytics-Builder-Setup-<version>.exe` as a workflow
artifact. Pushing a `v*` tag additionally attaches the installer to a GitHub
Release.

Locally on Windows:

```bash
npm ci
npm run dist:win     # → dist/InnovatIA-Analytics-Builder-Setup-1.0.0.exe
```

(On Linux, add `-- -c.win.signAndEditExecutable=false` or install wine for
exe resource stamping.)

Code signing: supply `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` (or Azure Trusted
Signing options) on the build agent. Certificates must never be committed.

## Architecture

```
src/main/       Electron main process — window lifecycle, secure IPC,
                local persistence of audit/dashboards/releases/settings
src/renderer/   The studio UI (no runtime dependencies)
  js/catalog.js       governed view catalogue, roles, hierarchies, templates
  js/guardrail.js     SQL validation gateway rules (§12.3)
  js/promptEngine.js  NL question → governed dashboard plan (§12.1)
  js/insights.js      variance/forecast/anomaly/narrative engine (§10)
  js/dashboard.js     §3 page anatomy builder + drill renderer
  js/charts.js        dependency-free SVG chart layer
  js/data.js          deterministic demo dataset (offline mode)
test/           node unit tests (npm test)
```

## Security posture (§12.3)

- Renderer runs sandboxed with context isolation; a narrow preload bridge
  exposes only persistence/export calls.
- Generated SQL is deny-by-default: single SELECT, catalogued views only.
- Secure (`SEC_*`) views are masked/aggregated for unauthorised roles.
- Recommendations are advisory: the product never creates, approves, pays,
  hires, terminates or alters a Fusion transaction.
