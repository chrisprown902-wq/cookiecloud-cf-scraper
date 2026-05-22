import { fetchCookies, fetchCookiesFromCDP, loadCookieCloudConfig } from './cookiecloud';
import { scrapeWithCloakBrowser } from './cloakbrowser';
import type { CloakBrowserOptions } from './cloakbrowser';
import type { PuppeteerCookie, ScrapeRequest, ScrapeResponse } from '../src/types';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

function getProxyEnv(): string | undefined {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
}

async function callWorker(url: string, body: ScrapeRequest): Promise<ScrapeResponse> {
  const proxy = getProxyEnv();
  // Try Node.js fetch first, fall back to curl
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      // Node.js undici fetch doesn't support proxy natively — will fail if direct blocked
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Worker returned ${res.status}: ${text}`);
    }
    return await res.json() as ScrapeResponse;
  } catch (fetchErr) {
    const fetchMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    if (!fetchMsg.includes('fetch failed') && !fetchMsg.includes('ETIMEDOUT') && !fetchMsg.includes('AbortError')) {
      throw fetchErr;
    }
    // Fall back to curl with proxy support
    console.error(`[cookiecloud-cf-scraper] Direct connection failed, trying curl${proxy ? ' with proxy' : ''}...`);
    const tmpFile = path.join(process.env.TEMP || '/tmp', `scrape_body_${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(body), 'utf-8');
    try {
      const proxyFlag = proxy ? `-x "${proxy}"` : '';
      const result = execSync(`curl.exe -s -m 60 ${proxyFlag} -X POST -H "Content-Type: application/json" -d "@${tmpFile}" "${url}"`, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
      return JSON.parse(result) as ScrapeResponse;
    } finally {
      fs.unlinkSync(tmpFile);
    }
  }
}

// Load .env from project root
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(path.resolve(__dirname, '..', '.env'));

interface CliArgs {
  url: string;
  output: 'html' | 'markdown' | 'text' | 'screenshot';
  waitSelector?: string;
  waitTimeout?: number;
  timeout: number;
  workerUrl: string;
  extraHeaders: Record<string, string>;
  outFile?: string;
  // CloakBrowser local mode
  local: boolean;
  humanize: boolean;
  headed: boolean;
  proxy?: string;
  profile?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Usage: npx tsx scripts/scrape.ts <url> [options]

Options:
  --output, -o    输出格式: html | markdown | text | screenshot (默认: html)
  --wait, -w      等待 CSS 选择器出现
  --wait-timeout  等待选择器出现后额外等待 ms (默认: 0)
  --timeout, -t   页面加载超时 ms (默认: 30000)
  --worker        CF Worker URL (默认: 从 CF_WORKER_URL 环境变量读取)
  --header, -H    附加请求头 key:value (可重复)
  --out-file      输出到文件而非 stdout (screenshot 模式下必需)

CloakBrowser local mode (--local):
  --local         使用本地 CloakBrowser 替代 CF Worker（指纹伪装 + 反检测）
  --humanize      模拟人类操作（贝塞尔鼠标曲线、自然键盘节奏）
  --headed        显示浏览器窗口（默认 headless）
  --proxy         代理 URL (socks5://user:pass@host:port 或 http://...)
  --profile       持久化用户数据目录（保存登录态跨会话复用）

Environment:
  COOKIECLOUD_URL      CookieCloud 服务地址
  COOKIECLOUD_UUID     CookieCloud UUID
  COOKIECLOUD_PASSWORD CookieCloud 密码
  CF_WORKER_URL        CF Worker 地址
`);
    process.exit(0);
  }

  const cliArgs: CliArgs = {
    url: args[0],
    output: 'html',
    timeout: 30000,
    workerUrl: process.env.CF_WORKER_URL || 'http://localhost:8787',
    extraHeaders: {},
    local: false,
    humanize: false,
    headed: false,
  };

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--output':
      case '-o':
        cliArgs.output = args[++i] as CliArgs['output'];
        break;
      case '--wait':
      case '-w':
        cliArgs.waitSelector = args[++i];
        break;
      case '--wait-timeout':
        cliArgs.waitTimeout = parseInt(args[++i], 10);
        break;
      case '--timeout':
      case '-t':
        cliArgs.timeout = parseInt(args[++i], 10);
        break;
      case '--worker':
        cliArgs.workerUrl = args[++i];
        break;
      case '--header':
      case '-H': {
        const h = args[++i];
        const idx = h.indexOf(':');
        if (idx > 0) {
          cliArgs.extraHeaders[h.substring(0, idx).trim()] = h.substring(idx + 1).trim();
        }
        break;
      }
      case '--out-file':
        cliArgs.outFile = args[++i];
        break;
      case '--local':
        cliArgs.local = true;
        break;
      case '--humanize':
        cliArgs.humanize = true;
        break;
      case '--headed':
        cliArgs.headed = true;
        break;
      case '--proxy':
        cliArgs.proxy = args[++i];
        break;
      case '--profile':
        cliArgs.profile = args[++i];
        break;
    }
  }

  // Validate URL
  try {
    new URL(cliArgs.url);
  } catch {
    console.error(`Invalid URL: ${cliArgs.url}`);
    process.exit(1);
  }

  return cliArgs;
}

async function main() {
  const args = parseArgs();
  const target = new URL(args.url);

  console.error(`[cookiecloud-cf-scraper] Target: ${args.url}`);
  console.error(`[cookiecloud-cf-scraper] Output: ${args.output}`);

  // Fetch cookies: try CDP first, fall back to CookieCloud server
  let cookies: PuppeteerCookie[] = [];
  try {
    console.error(`[cookiecloud-cf-scraper] Extracting cookies for ${target.hostname} via CDP...`);
    cookies = await fetchCookiesFromCDP(target.hostname);
    console.error(`[cookiecloud-cf-scraper] CDP: ${cookies.length} cookies`);
  } catch (cdpErr) {
    console.error(`[cookiecloud-cf-scraper] CDP unavailable (${cdpErr instanceof Error ? cdpErr.message : cdpErr}), trying CookieCloud...`);
    try {
      const config = loadCookieCloudConfig();
      cookies = await fetchCookies(target.hostname, config);
      console.error(`[cookiecloud-cf-scraper] CookieCloud: ${cookies.length} cookies`);
    } catch (ccErr) {
      console.error(`[cookiecloud-cf-scraper] CookieCloud also failed: ${ccErr instanceof Error ? ccErr.message : ccErr}`);
      console.error('[cookiecloud-cf-scraper] Continuing without cookies...');
      cookies = [];
    }
  }

  const scrapeOptions = {
    output: args.output,
    waitSelector: args.waitSelector,
    waitTimeout: args.waitTimeout,
    timeout: args.timeout,
    extraHeaders: Object.keys(args.extraHeaders).length > 0 ? args.extraHeaders : undefined,
  };

  let data: ScrapeResponse;
  const start = Date.now();

  if (args.local) {
    // ═══ CloakBrowser local mode ═══
    const cbOptions: CloakBrowserOptions = {
      headless: !args.headed,
      humanize: args.humanize,
      proxy: args.proxy,
      userDataDir: args.profile,
    };

    console.error(`[cookiecloud-cf-scraper] Launching CloakBrowser${args.humanize ? ' (humanize)' : ''}${args.proxy ? ` via ${args.proxy}` : ''}...`);
    data = await scrapeWithCloakBrowser(args.url, cookies, scrapeOptions, cbOptions);
  } else {
    // ═══ CF Worker remote mode ═══
    const body: ScrapeRequest = {
      url: args.url,
      cookies,
      options: scrapeOptions,
    };

    console.error(`[cookiecloud-cf-scraper] Calling Worker: ${args.workerUrl}/scrape`);
    data = await callWorker(`${args.workerUrl.replace(/\/$/, '')}/scrape`, body);
  }

  const elapsed = Date.now() - start;
  console.error(`[cookiecloud-cf-scraper] Completed in ${elapsed}ms`);

  if (!data.success) {
    console.error(`[cookiecloud-cf-scraper] Scrape failed: ${data.error}`);
    process.exit(1);
  }

  if (data.blocked) {
    console.error('[cookiecloud-cf-scraper] ⚠️  Page appears to be blocked (captcha/anti-bot detected)');
  }

  // Output
  if (args.output === 'screenshot') {
    const outPath = args.outFile || path.join(process.cwd(), 'screenshot.png');
    fs.writeFileSync(outPath, Buffer.from(data.output, 'base64'));
    console.error(`[cookiecloud-cf-scraper] Screenshot saved to ${outPath}`);
  } else if (args.outFile) {
    fs.writeFileSync(args.outFile, data.output, 'utf-8');
    console.error(`[cookiecloud-cf-scraper] Output saved to ${args.outFile}`);
  } else {
    process.stdout.write(data.output);
  }
}

main().catch(err => {
  console.error(`[cookiecloud-cf-scraper] Fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
