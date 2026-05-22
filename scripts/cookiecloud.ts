import crypto from 'crypto';
import type { CookieCloudCookie, CookieCloudData, PuppeteerCookie } from '../src/types';

export interface CookieCloudConfig {
  url: string;
  uuid: string;
  password: string;
}

/**
 * 从 CookieCloud 服务拉取指定域名的 Cookie，返回 Puppeteer 兼容格式
 */
export async function fetchCookies(domain: string, config: CookieCloudConfig): Promise<PuppeteerCookie[]> {
  const data = await fetchFromServer(config);
  const cookies = matchDomain(domain, data.cookie_data);
  return cookies.map(toPuppeteerCookie);
}

async function fetchFromServer(config: CookieCloudConfig): Promise<CookieCloudData> {
  const url = `${config.url.replace(/\/$/, '')}/get/${config.uuid}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: config.password }),
  });

  if (!res.ok) {
    throw new Error(`CookieCloud returned ${res.status}: ${res.statusText}`);
  }

  const body = await res.text();

  // Try parsing as JSON (server-side decryption)
  try {
    const parsed = JSON.parse(body);
    if (parsed.cookie_data) {
      return parsed as CookieCloudData;
    }
  } catch {
    // Not JSON, probably encrypted — decrypt locally
  }

  // Local decryption fallback
  return decryptLocally(body, config.uuid, config.password);
}

function decryptLocally(encrypted: string, uuid: string, password: string): CookieCloudData {
  // Try Fixed IV mode first (aes-128-cbc, key=MD5(uuid-password)[:16], iv=zeroes)
  try {
    const keyStr = crypto.createHash('md5').update(`${uuid}-${password}`).digest('hex').substring(0, 16);
    const key = Buffer.from(keyStr, 'utf8');
    const iv = Buffer.alloc(16, 0);
    // CryptoJS uses WordArray which is big-endian; when it converts a 16-char string
    // to a key, it interprets each char as a byte (Latin1), same as Buffer.from(keyStr, 'utf8')
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(encrypted, 'base64'), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    // Fixed IV failed, try CryptoJS-compatible (EvpKDF + "Salted__" prefix)
  }

  const raw = Buffer.from(encrypted, 'base64');

  // Check for OpenSSL "Salted__" prefix
  if (raw.toString('utf8', 0, 8) !== 'Salted__') {
    throw new Error('Unable to decrypt CookieCloud data: unknown encryption format');
  }

  const salt = raw.subarray(8, 16);
  const ciphertext = raw.subarray(16);
  const passphrase = Buffer.from(`${uuid}-${password}`, 'utf8');
  const { key, iv } = evpKDF(passphrase, salt, 32, 16);

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

/** OpenSSL-compatible EvpKDF (MD5, 1 iteration, used by CryptoJS default) */
function evpKDF(password: Buffer, salt: Buffer, keyLen: number, ivLen: number): { key: Buffer; iv: Buffer } {
  const totalLen = keyLen + ivLen;
  const derived = Buffer.alloc(totalLen);
  let prev = Buffer.alloc(0);
  let offset = 0;

  while (offset < totalLen) {
    const md5 = crypto.createHash('md5');
    md5.update(prev);
    md5.update(password);
    md5.update(salt);
    prev = md5.digest();
    const copyLen = Math.min(prev.length, totalLen - offset);
    prev.copy(derived, offset, 0, copyLen);
    offset += copyLen;
  }

  return {
    key: derived.subarray(0, keyLen),
    iv: derived.subarray(keyLen, keyLen + ivLen),
  };
}

/** 按域名匹配 Cookie（支持子域名和父域名匹配） */
function matchDomain(target: string, cookieData: Record<string, CookieCloudCookie[]>): CookieCloudCookie[] {
  const results: CookieCloudCookie[] = [];

  // Normalize: strip www. prefix for matching
  const normalized = target.replace(/^www\./, '');

  for (const [domain, cookies] of Object.entries(cookieData)) {
    const d = domain.replace(/^\./, '');
    // Match if cookie domain is suffix of target or vice versa
    if (normalized.endsWith(d) || d.endsWith(normalized) || normalized === d) {
      results.push(...cookies);
    }
  }

  return results;
}

/** 将 CookieCloud Cookie 转为 Puppeteer setCookie 兼容格式 */
function toPuppeteerCookie(c: CookieCloudCookie): PuppeteerCookie {
  const sameSiteMap: Record<string, PuppeteerCookie['sameSite']> = {
    strict: 'Strict',
    lax: 'Lax',
    none: 'None',
    no_restriction: 'None',
    unspecified: 'Lax',
  };

  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    sameSite: sameSiteMap[c.sameSite?.toLowerCase() ?? ''] ?? 'Lax',
    expires: c.expirationDate
      ? c.expirationDate
      : Math.floor(Date.now() / 1000) + 86400 * 365,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? true,
  };
}

// ═══════════════════════════════════════════
// CDP mode: extract cookies directly from Edge
// ═══════════════════════════════════════════

interface CDPCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
}

/**
 * 通过 Chrome DevTools Protocol 直接从 Edge 提取 Cookie
 * 需要 Edge 以 --remote-debugging-port=9222 启动
 */
export async function fetchCookiesFromCDP(domain: string): Promise<PuppeteerCookie[]> {
  const cdpPort = parseInt(process.env.CDP_PORT || '9222', 10);
  const cdpUrl = `http://localhost:${cdpPort}`;

  // Check if CDP is available
  let versionRes: Response;
  try {
    versionRes = await fetch(`${cdpUrl}/json/version`);
  } catch {
    throw new Error(`Edge CDP not available at ${cdpUrl}. Start Edge with: msedge --remote-debugging-port=${cdpPort}`);
  }

  // Verify CDP is alive
  await versionRes.json();

  // Get page targets
  const targetsRes = await fetch(`${cdpUrl}/json`);
  const targets: Array<{ type: string; url: string; id: string; webSocketDebuggerUrl: string }> = await targetsRes.json();
  const pageTarget = targets.find(t => t.type === 'page');

  if (!pageTarget) {
    throw new Error('No open page found in Edge. Open any tab and retry.');
  }

  // Connect to page via WebSocket
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  let msgId = 1;
  const pending = new Map<number, (v: Record<string, unknown>) => void>();

  ws.addEventListener('message', (event: MessageEvent) => {
    const msg = JSON.parse(event.data as string) as { id?: number; result?: Record<string, unknown> };
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => {
      for (const [, cb] of pending) cb({ error: 'WebSocket error' });
      pending.clear();
      reject(new Error('CDP WebSocket connection failed'));
    });
    setTimeout(() => {
      for (const [, cb] of pending) cb({ error: 'CDP timeout' });
      pending.clear();
      reject(new Error('CDP WebSocket timeout'));
    }, 5000);
  });

  function send(method: string, params = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 10000);
    });
  }

  // Enable Network and get all cookies
  await send('Network.enable');
  const allResp = await send('Network.getAllCookies');
  const result = allResp.result as { cookies?: CDPCookie[] } | undefined;
  const allCookies = result?.cookies || [];

  ws.close();

  // Filter by domain — use suffix match to avoid false positives
  const filtered = allCookies.filter(c => {
    const cd = (c.domain || '').replace(/^\./, '');
    const target = domain.replace(/^\./, '');
    return cd === target || cd.endsWith('.' + target);
  });

  return filtered.map(c => {
    let value = c.value;
    try { value = decodeURIComponent(c.value); } catch { /* keep as-is */ }
    return {
      name: c.name,
      value,
      domain: c.domain,
      path: c.path || '/',
      sameSite: normalizeSameSite(c.sameSite),
      expires: c.expires ?? Math.floor(Date.now() / 1000) + 86400 * 365,
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? true,
    };
  });
}

function normalizeSameSite(s?: string): PuppeteerCookie['sameSite'] {
  const map: Record<string, PuppeteerCookie['sameSite']> = {
    strict: 'Strict',
    lax: 'Lax',
    none: 'None',
    no_restriction: 'None',
    unspecified: 'Lax',
  };
  return map[s?.toLowerCase() ?? ''] ?? 'Lax';
}

/**
 * 解析 CookieCloud 配置
 */
export function loadCookieCloudConfig(): CookieCloudConfig {
  const url = process.env.COOKIECLOUD_URL;
  const uuid = process.env.COOKIECLOUD_UUID;
  const password = process.env.COOKIECLOUD_PASSWORD;

  if (!url) throw new Error('COOKIECLOUD_URL environment variable is not set');
  if (!uuid) throw new Error('COOKIECLOUD_UUID environment variable is not set');
  if (!password) throw new Error('COOKIECLOUD_PASSWORD environment variable is not set');

  return { url, uuid, password };
}
