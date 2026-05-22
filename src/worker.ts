import puppeteer from '@cloudflare/puppeteer';
import type { BrowserWorker, Browser, CookieParam } from '@cloudflare/puppeteer';
import type { ScrapeRequest, ScrapeResponse } from './types';
import { htmlToMarkdown, base64FromBuffer } from './utils';

interface Env {
  MYBROWSER: BrowserWorker;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/scrape') {
      return handleScrape(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    return new Response('POST /scrape or GET /health', { status: 404 });
  },
};

async function handleScrape(request: Request, env: Env): Promise<Response> {
  let body: ScrapeRequest;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, url: '', error: 'Invalid JSON body', output: '', contentType: 'text/plain' }, 400);
  }

  const { url: targetUrl, cookies, options = {} } = body;

  if (!targetUrl || !cookies || !Array.isArray(cookies)) {
    return jsonResponse({ success: false, url: targetUrl || '', error: 'Missing url or cookies array', output: '', contentType: 'text/plain' }, 400);
  }

  const {
    waitSelector,
    waitTimeout = 0,
    output = 'html',
    timeout = 30000,
    extraHeaders = {},
  } = options;

  // Try to reuse an existing idle session
  let browser: Browser;
  const sessions = await puppeteer.sessions(env.MYBROWSER);
  const idle = sessions.filter(s => !s.connectionId);
  if (idle.length > 0) {
    browser = await puppeteer.connect(env.MYBROWSER, idle[0].sessionId);
  } else {
    browser = await puppeteer.launch(env.MYBROWSER);
  }

  try {
    const page = await browser.newPage();

    // Set extra headers before navigation
    if (Object.keys(extraHeaders).length > 0) {
      await page.setExtraHTTPHeaders(extraHeaders);
    }

    // Inject cookies — must navigate to origin first so cookies can be set
    const targetOrigin = new URL(targetUrl).origin;
    await page.goto(targetOrigin + '/favicon.ico', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {
      // favicon fetch may fail, that's fine — we just need the origin loaded
    });

    // Normalize and set cookies
    const normalized = cookies.map(normalizeCookie);
    await page.setCookie(...normalized);

    // Navigate to target
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout });

    // Wait for specific selector if requested
    if (waitSelector) {
      try {
        await page.waitForSelector(waitSelector, { timeout });
      } catch {
        // selector never appeared — page might be blocked or still loading
      }
    }

    // Extra wait
    if (waitTimeout > 0) {
      await new Promise(r => setTimeout(r, waitTimeout));
    }

    // Check for anti-bot blocking
    const pageTitle = await page.title();
    const blocked = /captcha|blocked|access denied|verify|are you a robot/i.test(pageTitle);

    let result: string;
    let contentType: string;

    switch (output) {
      case 'screenshot': {
        const buf = await page.screenshot({ type: 'png', fullPage: true });
        result = base64FromBuffer(buf);
        contentType = 'image/png;base64';
        break;
      }
      case 'text': {
        result = await page.evaluate('document.body.innerText || ""') as string;
        contentType = 'text/plain';
        break;
      }
      case 'markdown': {
        const html = await page.content();
        result = htmlToMarkdown(html);
        contentType = 'text/markdown';
        break;
      }
      case 'html':
      default: {
        result = await page.content();
        contentType = 'text/html';
        break;
      }
    }

    return jsonResponse({
      success: true,
      url: targetUrl,
      output: result,
      contentType,
      blocked,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({
      success: false,
      url: targetUrl,
      error: message,
      output: '',
      contentType: 'text/plain',
    }, 502);
  } finally {
    // Disconnect (not close) so the session can be reused
    await browser.disconnect();
  }
}

function normalizeCookie(c: { name: string; value: string; domain: string; path?: string; sameSite?: string; expires?: number; httpOnly?: boolean; secure?: boolean }): CookieParam {
  let sameSite: CookieParam['sameSite'] = 'Lax';
  if (c.sameSite) {
    const s = c.sameSite.toLowerCase();
    if (s === 'strict') sameSite = 'Strict';
    else if (s === 'none') sameSite = 'None';
  }

  return {
    name: c.name,
    value: c.value,
    domain: c.domain.startsWith('.') ? c.domain : '.' + c.domain,
    path: c.path || '/',
    sameSite,
    expires: typeof c.expires === 'number' ? c.expires : Math.floor(Date.now() / 1000) + 86400 * 365,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
  };
}

function jsonResponse(data: ScrapeResponse, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
