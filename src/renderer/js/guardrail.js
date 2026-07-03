'use strict';

import { VIEW_INDEX, SENSITIVE_COLUMNS } from './catalog.js';

// ---------------------------------------------------------------------------
// SQL guardrail (§12.3): every statement the AI planner drafts — and anything
// a user edits by hand — passes through here before it may execute. The rules
// are deny-by-default: single SELECT statement, approved RPT_*/SEC_* views
// only, no DDL/DML/PL-SQL, no database links, no unsafe packages, no
// unapproved schemas, sensitive columns blocked, row limit enforced.
// ---------------------------------------------------------------------------

const FORBIDDEN_STATEMENTS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE',
  'GRANT', 'REVOKE', 'RENAME', 'COMMENT', 'LOCK', 'CALL', 'EXECUTE', 'BEGIN',
  'DECLARE', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'SET'
];

const FORBIDDEN_PACKAGES = [
  'DBMS_', 'UTL_', 'CTX_', 'OWA_', 'HTP.', 'HTF.', 'SYS.', 'SYSTEM.',
  'XMLTYPE', 'DBLINK', 'JAVA_'
];

export const DEFAULT_ROW_LIMIT = 500;

function stripLiteralsAndComments(sql) {
  // Remove string literals and comments so keyword scanning cannot be fooled
  // by (or false-positive on) quoted text.
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

export function extractReferencedObjects(sql) {
  const cleaned = stripLiteralsAndComments(sql);
  const objects = new Set();
  const re = /\b(?:FROM|JOIN)\s+([A-Za-z0-9_$.@"]+)/gi;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    let obj = m[1].replace(/"/g, '').trim();
    if (obj.startsWith('(')) continue; // inline view — its own FROMs are scanned too
    objects.add(obj.toUpperCase());
  }
  return [...objects];
}

export function validateSql(sql, { role, rowLimit = DEFAULT_ROW_LIMIT } = {}) {
  const errors = [];
  const warnings = [];
  const text = (sql || '').trim();

  if (!text) {
    return { ok: false, errors: ['Empty statement.'], warnings, views: [], sql: text };
  }

  const cleaned = stripLiteralsAndComments(text);

  // Single statement only.
  if (/;/.test(cleaned.replace(/;\s*$/, ''))) {
    errors.push('Multiple statements are not permitted (semicolon detected).');
  }

  // Must be a SELECT (WITH ... SELECT allowed).
  const firstWord = cleaned.replace(/^[\s(]+/, '').split(/\s+/)[0]?.toUpperCase();
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    errors.push(`Only SELECT statements are permitted (found "${firstWord}").`);
  }

  // DDL / DML / PL-SQL keywords anywhere in the statement.
  for (const kw of FORBIDDEN_STATEMENTS) {
    const re = new RegExp(`(^|[^A-Za-z0-9_])${kw}([^A-Za-z0-9_]|$)`, 'i');
    if (re.test(cleaned)) {
      errors.push(`Forbidden keyword "${kw}" — DDL, DML and PL/SQL are rejected.`);
    }
  }

  // Database links and unsafe packages/schemas.
  if (/@/.test(cleaned)) errors.push('Database links ("@") are not permitted.');
  for (const pkg of FORBIDDEN_PACKAGES) {
    if (cleaned.toUpperCase().includes(pkg)) {
      errors.push(`Unsafe package or schema reference "${pkg}" is not permitted.`);
    }
  }

  // Referenced objects must be approved catalogue views.
  const objects = extractReferencedObjects(text);
  const views = [];
  for (const obj of objects) {
    if (obj.includes('.')) {
      errors.push(`Schema-qualified object "${obj}" — only the governed reporting schema is exposed.`);
      continue;
    }
    const view = VIEW_INDEX.get(obj);
    if (!view) {
      errors.push(`"${obj}" is not an approved reporting view. Only catalogued RPT_*/SEC_*/AI_* objects may be queried.`);
    } else {
      views.push(view);
      if (view.secure && role && !role.canSeeSecure) {
        warnings.push(`"${obj}" is a secure view: rows will be masked/aggregated for role "${role.label}".`);
      }
    }
  }
  if (objects.length === 0) {
    errors.push('No reporting view referenced — a governed FROM clause is required.');
  }

  // Sensitive columns are blocked at the gateway regardless of view.
  for (const col of SENSITIVE_COLUMNS) {
    const re = new RegExp(`(^|[^A-Za-z0-9_])${col}([^A-Za-z0-9_]|$)`, 'i');
    if (re.test(cleaned)) {
      errors.push(`Sensitive column "${col}" is blocked by data-masking policy.`);
    }
  }

  // Row limit enforced before results leave the gateway.
  let finalSql = text.replace(/;\s*$/, '');
  if (!/FETCH\s+FIRST\s+\d+\s+ROWS?\s+ONLY/i.test(cleaned)) {
    finalSql = `${finalSql}\nFETCH FIRST ${rowLimit} ROWS ONLY`;
    warnings.push(`Row limit of ${rowLimit} applied by the gateway.`);
  }

  return { ok: errors.length === 0, errors, warnings, views, sql: finalSql };
}
