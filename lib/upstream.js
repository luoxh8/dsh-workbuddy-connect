/**
 * WorkBuddy upstream access for the DSH account pool.
 *
 * Reads the same vault the `dsh-connect-workbuddy` plugin writes
 * (`~/.dsh/workbuddy-vault/cn/<accountId>.json`), refreshes an expired access
 * token through the WorkBuddy desktop refresh endpoint, and speaks the growth
 * API with the client's own wire shape.
 *
 * No credential is ever printed: `describe()` shows a masked token and nothing
 * else. Refresh results are written back to the vault so a later run does not
 * have to refresh again.
 *
 * @module dsh-workbuddy-growth/upstream
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Domestic gateways. Growth reads answer on both; a write is retried on the second. */
export const GROWTH_BASES = ['https://www.codebuddy.cn', 'https://www.workbuddy.cn'];
/** Billing (check-in) lives on the account domain only. */
export const BILLING_BASE = 'https://www.codebuddy.cn';
/** Telemetry ingress: this is where `/v2/report` posts land. */
export const REPORT_BASE = 'https://copilot.tencent.com';

/** App version this plugin claims in `User-Agent`, matching the desktop build. */
const APP_VERSION = '5.24.9';
const PRODUCT_UA = `WorkBuddy/${APP_VERSION} WorkBuddy/${APP_VERSION} CLI/2.161.0`;
const REQUEST_TIMEOUT_MS = 30_000;

/** Refresh a token this long before it actually expires. */
const REFRESH_MARGIN_MS = 10 * 60_000;

/** Default vault directory for the domestic region. */
export function defaultVaultDir() {
  return join(homedir(), '.dsh', 'workbuddy-vault', 'cn');
}

/** The HTTP status and parsed body of one call; `json` is null for a non-JSON body. */
async function call(url, init) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (error) {
    return { status: 0, json: null, text: `transport error: ${String(error)}` };
  }
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

/** `{ code, msg, data }` is the envelope every WorkBuddy business endpoint returns. */
function envelopeOf(result) {
  const body = result.json;
  const code = typeof body?.code === 'number' ? body.code : result.status === 200 ? 0 : result.status;
  const message =
    typeof body?.msg === 'string' ? body.msg : typeof body?.message === 'string' ? body.message : '';
  return { code, message, data: body?.data ?? null, ok: result.status === 200 && code === 0 };
}

/** Headers the desktop client sends on a growth request for one credential. */
function growthHeaders(credential) {
  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': PRODUCT_UA,
    'X-Requested-With': 'XMLHttpRequest',
    'X-CodeBuddy-Request': '1',
    'X-Product': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '0.0.0',
  };
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid;
  else headers['X-No-User-Id'] = '1';
  headers['X-No-Enterprise-Id'] = '1';
  if (credential.domain !== '') {
    headers['X-Domain'] = credential.domain;
    headers.Origin = originOf(credential);
    headers.Referer = `${originOf(credential)}/`;
  } else {
    headers['X-No-Department-Info'] = '1';
  }
  return headers;
}

/** The web origin matching a credential's domain. */
function originOf(credential) {
  return `https://${credential.domain === '' ? 'www.codebuddy.cn' : credential.domain}`;
}

/** Headers for the telemetry ingress; the reporter sends no Origin. */
function reportHeaders(credential) {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': PRODUCT_UA,
    'X-Requested-With': 'XMLHttpRequest',
    'X-CodeBuddy-Request': '1',
    'X-Product': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '0.0.0',
    ...(credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid }),
    'X-No-Enterprise-Id': '1',
    ...(credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain }),
  };
}

/** Headers for the check-in endpoints; the billing domain wants the bare three plus attribution. */
function billingHeaders(credential) {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': `WorkBuddy/${APP_VERSION}`,
    'X-Requested-With': 'XMLHttpRequest',
    'X-CodeBuddy-Request': '1',
    ...(credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid }),
    'X-No-Enterprise-Id': '1',
    ...(credential.domain === '' ? {} : { 'X-Domain': credential.domain, Origin: originOf(credential), Referer: `${originOf(credential)}/` }),
  };
}

/** One credential as the rest of this module uses it. */
function credentialOf(record, filePath) {
  const auth = record?.auth ?? {};
  const account = record?.account ?? {};
  return {
    accountId: typeof record?.accountId === 'string' && record.accountId !== '' ? record.accountId : '',
    nickname: typeof account.nickname === 'string' ? account.nickname : '',
    uid: typeof account.uid === 'string' ? account.uid : '',
    uin: typeof account.uin === 'string' ? account.uin : '',
    accessToken: typeof auth.accessToken === 'string' ? auth.accessToken : '',
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    // The vault stores seconds; the rest of this module works in milliseconds.
    expiresAtMs: typeof auth.expiresAt === 'number' ? auth.expiresAt * 1000 : 0,
    domain: typeof auth.domain === 'string' ? auth.domain : '',
    filePath,
    record,
  };
}

/**
 * Read every account in `vaultDir`.
 *
 * The vault holds one file per account plus a dot-prefixed bookkeeping file that
 * is not an account, so only `*.json` names that do not start with `.` count.
 *
 * @param vaultDir - directory holding `<accountId>.json` files.
 * @returns the credentials in file-name order.
 */
export async function loadAccounts(vaultDir = defaultVaultDir()) {
  const names = await readdir(vaultDir).catch(() => []);
  const accounts = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const filePath = join(vaultDir, name);
    let record;
    try {
      record = JSON.parse(await readFile(filePath, 'utf8'));
    } catch {
      continue;
    }
    const credential = credentialOf(record, filePath);
    if (credential.accessToken === '') continue;
    accounts.push(credential);
  }
  return accounts;
}

/** A masked token, for a status line that may end up in a log. */
export function masked(token) {
  return token.length <= 12 ? `${token.length} chars` : `${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)`;
}

/**
 * Refresh one credential through the desktop refresh endpoint and persist the
 * result into the same vault file, keeping every unrelated field.
 *
 * @param credential - the loaded credential.
 * @returns the credential, now carrying a usable access token.
 */
export async function refresh(credential) {
  for (const base of GROWTH_BASES) {
    const result = await call(`${base}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: {
        ...growthHeaders(credential),
        'X-Refresh-Token': credential.refreshToken,
        'X-Auth-Refresh-Source': 'workbuddy',
      },
      body: JSON.stringify({}),
    });
    const envelope = envelopeOf(result);
    const accessToken = typeof envelope.data?.accessToken === 'string' ? envelope.data.accessToken : '';
    if (!envelope.ok || accessToken === '') continue;

    const next = { ...credential, accessToken };
    const refreshToken = typeof envelope.data?.refreshToken === 'string' ? envelope.data.refreshToken : '';
    if (refreshToken !== '') next.refreshToken = refreshToken;
    const expiresIn = typeof envelope.data?.expiresIn === 'number' ? envelope.data.expiresIn : 0;
    if (expiresIn > 0) next.expiresAtMs = Date.now() + expiresIn * 1000;
    const domain = typeof envelope.data?.domain === 'string' ? envelope.data.domain : '';
    if (domain !== '') next.domain = domain;

    const persisted = {
      ...credential.record,
      refreshedAtMs: Date.now(),
      auth: {
        ...(credential.record?.auth ?? {}),
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        ...(expiresIn > 0 ? { expiresAt: Math.floor(next.expiresAtMs / 1000) } : {}),
        ...(domain !== '' ? { domain } : {}),
      },
    };
    await writeFile(credential.filePath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8').catch(() => {});
    return { ...next, record: persisted };
  }
  throw new Error(`token refresh failed for ${credential.nickname || credential.accountId}`);
}

/** Refresh only when the access token is expired or about to expire. */
export async function ensureFresh(credential) {
  if (credential.refreshToken === '') return credential;
  if (credential.expiresAtMs > Date.now() + REFRESH_MARGIN_MS) return credential;
  return refresh(credential);
}

/** One growth call, retried against the second gateway before it reports a failure. */
export async function growth(credential, method, path, body) {
  const attempts = [];
  for (const base of GROWTH_BASES) {
    const result = await call(`${base}${path}`, {
      method,
      headers: growthHeaders(credential),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const envelope = envelopeOf(result);
    if (envelope.ok) return envelope;
    attempts.push(`${base}${path} → HTTP ${result.status} ${envelope.message || result.text.slice(0, 160)}`);
  }
  return { ok: false, code: 0, message: attempts.join(' | '), data: null };
}

/** One billing call, on the account domain only. */
export async function billing(credential, path, body) {
  const result = await call(`${BILLING_BASE}${path}`, {
    method: 'POST',
    headers: billingHeaders(credential),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return envelopeOf(result);
}

/**
 * Post one telemetry batch to `/v2/report`.
 *
 * The reporter sends an array of events; the growth service reads a subset of
 * those codes as evidence that a client-side action happened (see
 * `lib/actions.js` for the batches this plugin sends).
 *
 * @param credential - the acting credential.
 * @param events - event objects without the ambient fields, which are added here.
 * @returns `{ ok, status }` for the ingress call.
 */
export async function report(credential, events) {
  const stamp = Date.now();
  const payload = events.map((event, index) => ({
    timestamp: stamp + index,
    reportDelay: 0,
    userId: credential.uid,
    userNickname: credential.nickname,
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 WorkBuddy/${APP_VERSION}`,
    os: 'Win32',
    timezone: 'Asia/Shanghai',
    ...event,
  }));
  for (const base of [REPORT_BASE, ...GROWTH_BASES]) {
    const result = await call(`${base}/v2/report`, {
      method: 'POST',
      headers: reportHeaders(credential),
      body: JSON.stringify(payload),
    });
    if (result.status === 200) return { ok: true, status: result.status, base };
  }
  return { ok: false, status: 0, base: '' };
}
