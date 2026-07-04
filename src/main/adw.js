'use strict';

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Direct Oracle ADW connectivity (no gateway required).
//
// The desktop client connects straight to Autonomous Data Warehouse using the
// downloaded mTLS wallet + database credentials. Two layers:
//
//   1. node-oracledb "thin" mode (pure JavaScript — no Oracle Instant Client
//      install) performs a real SQL handshake and runs the dictionary /
//      workbench queries when the driver is bundled.
//   2. If the driver is not present, a dependency-free TLS reachability probe
//      still verifies the ADW host:port is reachable and completes a TLS
//      handshake, so "Test connection" gives a genuine result either way.
//
// The driver is an OPTIONAL dependency and loaded lazily, so a build without
// it still runs (demo mode + reachability test) and never fails to start.
// ---------------------------------------------------------------------------

let oracledb = null;
let oracledbTried = false;
function loadDriver() {
  if (oracledbTried) return oracledb;
  oracledbTried = true;
  try {
    oracledb = require('oracledb'); // thin mode is the default; no client needed
    oracledb.autoCommit = false;
  } catch {
    oracledb = null;
  }
  return oracledb;
}

// Extract host + port from an Oracle "long" connect descriptor or a bare host.
function parseEndpoint(connectString, fallbackPort = 1522) {
  if (!connectString) return null;
  const s = String(connectString);
  const host = /\(HOST\s*=\s*([^)\s]+)\)/i.exec(s);
  const port = /\(PORT\s*=\s*(\d+)\)/i.exec(s);
  if (host) return { host: host[1], port: port ? Number(port[1]) : fallbackPort };
  // Easy-connect form host:port/service, or a bare hostname
  const ec = /^([^:/\s]+)(?::(\d+))?/.exec(s.trim());
  if (ec) return { host: ec[1], port: ec[2] ? Number(ec[2]) : fallbackPort };
  return null;
}

// Read the endpoint for a service alias out of an unzipped wallet's
// tnsnames.ora, or fall back to the host field the user typed.
function resolveEndpoint({ walletDir, serviceName, host }) {
  if (walletDir) {
    const tns = path.join(walletDir, 'tnsnames.ora');
    if (fs.existsSync(tns)) {
      const txt = fs.readFileSync(tns, 'utf8');
      const alias = (serviceName || '').trim();
      // Match "alias = (DESCRIPTION=...)" up to the next top-level alias.
      const re = new RegExp(`(^|\\n)\\s*${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(\\([\\s\\S]*?\\))\\s*(\\n\\S|$)`, 'i');
      const m = alias ? re.exec(txt) : null;
      const descriptor = m ? m[2] : txt; // any DESCRIPTION if alias not found
      const ep = parseEndpoint(descriptor);
      if (ep) return ep;
    }
  }
  return parseEndpoint(host);
}

// Unzip a wallet .zip into a private temp dir (thin mode reads the PEM/SSO).
// Extracts once per session; returns null for a missing/invalid path so the
// caller can surface a clean error instead of throwing across IPC.
const walletCache = new Map();
function prepareWallet(walletPath) {
  if (!walletPath) return null;
  let stat;
  try { stat = fs.statSync(walletPath); } catch { return null; }
  if (stat.isDirectory()) return walletPath;
  if (!/\.zip$/i.test(walletPath)) return path.dirname(walletPath);
  if (walletCache.has(walletPath)) return walletCache.get(walletPath);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'innovatia-wallet-'));
  let dir;
  try { extractZip(walletPath, dest); dir = dest; }  // pure-JS store/deflate extractor
  catch { dir = path.dirname(walletPath); }
  walletCache.set(walletPath, dir);
  return dir;
}

// Minimal ZIP extractor (store + deflate) — avoids adding a dependency.
function extractZip(zipPath, dest) {
  const zlib = require('zlib');
  const buf = fs.readFileSync(zipPath);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lnameLen = buf.readUInt16LE(localOff + 26);
    const lextraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lnameLen + lextraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const out = method === 0 ? comp : zlib.inflateRawSync(comp);
    const safe = path.basename(name); // wallets are flat; guard traversal
    fs.writeFileSync(path.join(dest, safe), out);
  }
}

// Dependency-free reachability + TLS handshake test.
function tlsProbe({ host, port, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve({ ...r, latencyMs: Date.now() - started }); } };
    // ADW mTLS ports expect a client cert; we only need to confirm the TLS
    // server responds, so ignore auth errors from the handshake itself.
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => done({ ok: true }));
    sock.on('secureConnect', () => done({ ok: true }));
    sock.on('timeout', () => { sock.destroy(); done({ ok: false, error: `Timed out connecting to ${host}:${port}` }); });
    sock.on('error', (e) => {
      // A TLS-layer error still proves the port is a live TLS endpoint.
      if (/certificate|handshake|alert|ssl|tls/i.test(e.message)) done({ ok: true, note: 'TLS endpoint reachable' });
      else done({ ok: false, error: e.code === 'ECONNREFUSED' ? `Connection refused at ${host}:${port}` : e.message });
    });
  });
}

// A single live pool per session, keyed loosely; recreated on settings change.
let pool = null;
let poolKey = '';

async function getConnection({ adw, walletPath, password, timeoutMs }) {
  const db = loadDriver();
  if (!db) return null;
  const walletDir = prepareWallet(walletPath);
  const key = `${adw.username}@${adw.serviceName}|${walletDir}|${adw.host}`;
  if (pool && poolKey !== key) { try { await pool.close(0); } catch {} pool = null; }
  if (!pool) {
    pool = await db.createPool({
      user: adw.username,
      password,
      connectString: adw.serviceName || adw.host,
      walletLocation: walletDir || undefined,
      walletPassword: adw.walletPassword || undefined,
      configDir: walletDir || undefined,
      poolMin: 0, poolMax: 4, poolTimeout: 60
    });
    poolKey = key;
  }
  return pool.getConnection();
}

async function test({ adw, walletPath, password, timeoutMs = 15000 }) {
  const db = loadDriver();
  const ep = resolveEndpoint({ walletDir: prepareWallet(walletPath), serviceName: adw.serviceName, host: adw.host });

  if (db) {
    let conn;
    try {
      conn = await getConnection({ adw, walletPath, password, timeoutMs });
      const r = await conn.execute("SELECT sys_context('USERENV','DB_NAME') AS db, sys_context('USERENV','SESSION_USER') AS usr FROM dual");
      const row = r.rows?.[0] || {};
      return {
        ok: true,
        detail: `Connected directly to Oracle ADW — database ${row[0] || adw.serviceName}, session user ${row[1] || adw.username} `
          + `(${adw.access === 'write' ? 'READ-WRITE' : 'READ-ONLY'}, mTLS wallet). No gateway required.`,
        driver: 'oracledb-thin'
      };
    } catch (e) {
      return { ok: false, detail: `Direct ADW connection failed: ${e.message}` };
    } finally { if (conn) { try { await conn.close(); } catch {} } }
  }

  // No driver bundled — fall back to a reachability handshake.
  if (!ep) return { ok: false, detail: 'Could not determine the ADW host from the wallet or the Host / TNS field. Enter the connect string or select the wallet.' };
  const probe = await tlsProbe({ ...ep, timeoutMs });
  return probe.ok
    ? { ok: true, detail: `ADW endpoint ${ep.host}:${ep.port} reachable over TLS (${probe.latencyMs} ms). Credentials will be validated on first query.`, driver: 'tls-probe' }
    : { ok: false, detail: `Cannot reach ADW at ${ep.host}:${ep.port}: ${probe.error}. Check the wallet, network egress and that the instance is running.` };
}

async function query({ adw, walletPath, password, sql, binds = {}, maxRows = 500, timeoutMs = 30000 }) {
  const db = loadDriver();
  if (!db) return { ok: false, error: 'The Oracle driver is not available in this build; live SQL requires the bundled node-oracledb.' };
  let conn;
  try {
    conn = await getConnection({ adw, walletPath, password, timeoutMs });
    const r = await conn.execute(sql, binds, { outFormat: db.OUT_FORMAT_OBJECT, maxRows });
    return { ok: true, columns: (r.metaData || []).map((m) => m.name), rows: r.rows || [], rowsAffected: r.rowsAffected || 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { if (conn) { try { await conn.close(); } catch {} } }
}

async function closePool() { if (pool) { try { await pool.close(0); } catch {} pool = null; } }

module.exports = { test, query, closePool, driverAvailable: () => !!loadDriver() };
