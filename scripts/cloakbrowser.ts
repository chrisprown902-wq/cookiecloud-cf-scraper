import { launch, launchPersistentContext } from 'cloakbrowser';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { PuppeteerCookie, ScrapeResponse, ScrapeOptions } from '../src/types';
import { htmlToMarkdown, base64FromBuffer } from '../src/utils';

export interface CloakBrowserOptions {
  headless?: boolean;
  humanize?: boolean;
  humanPreset?: 'default' | 'careful';
  proxy?: string;
  userDataDir?: string;
  timezone?: string;
  locale?: string;
}

export async function scrapeWithCloakBrowser(
  targetUrl: string,
  cookies: PuppeteerCookie[],
  options: ScrapeOptions = {},
  cbOptions: CloakBrowserOptions = {}
): Promise<ScrapeResponse> {
  const {
    waitSelector,
    waitTimeout = 0,
    output = 'html',
    timeout = 30000,
    extraHeaders = {},
  } = options;

  const {
    headless = true,
    humanize = false,
    humanPreset = 'default',
    proxy,
    userDataDir,
    timezone,
    locale,
  } = cbOptions;

  const launchOpts = {
    headless,
    ...(proxy ? { proxy } : {}),
    ...(timezone ? { timezone } : {}),
    ...(locale ? { locale } : {}),
  };

  let browser: Browser | undefined;
  let context: BrowserContext;

  if (userDataDir) {
    context = await launchPersistentContext({
      ...launchOpts,
      userDataDir,
      humanize,
      humanPreset,
    });
  } else {
    browser = await launch({
      ...launchOpts,
      humanize,
      humanPreset,
    });
    context = browser.contexts()[0];
  }

  try {
    // Inject cookies before any navigation — Playwright context-level, no pre-nav needed
    if (cookies.length > 0) {
      await context.addCookies(
        cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite as 'Strict' | 'Lax' | 'None',
        }))
      );
    }

    const page = await context.newPage();

    // Set extra headers
    if (Object.keys(extraHeaders).length > 0) {
      await page.setExtraHTTPHeaders(extraHeaders);
    }

    // Navigate
    await page.goto(targetUrl, { waitUntil: 'load', timeout });

    // Post-navigation waits
    if (waitSelector) {
      try {
        await page.waitForSelector(waitSelector, { timeout });
      } catch {
        // selector never appeared
      }
    }

    if (waitTimeout > 0) {
      await new Promise(r => setTimeout(r, waitTimeout));
    }

    // Anti-bot detection
    const pageTitle = await page.title();
    const blocked = /captcha|blocked|access denied|verify|are you a robot/i.test(pageTitle);

    let result: string;
    let contentType: string;

    switch (output) {
      case 'screenshot': {
        const buf = await page.screenshot({ type: 'png', fullPage: true });
        result = base64FromBuffer(new Uint8Array(buf));
        contentType = 'image/png;base64';
        break;
      }
      case 'text': {
        result = await page.evaluate('document.body.innerText || ""');
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

    return { success: true, url: targetUrl, output: result, contentType, blocked };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, url: targetUrl, error: message, output: '', contentType: 'text/plain' };
  } finally {
    if (browser) {
      await browser.close();
    } else {
      await context.close();
    }
  }
}
