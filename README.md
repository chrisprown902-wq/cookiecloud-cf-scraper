# CookieCloud × CloakBrowser × CF Worker

Triple-layer anti-detection web scraping. Login state → browser fingerprint → human behavior, all covered.

## Architecture

```
Real Browser (CookieCloud extension / Edge CDP)
    │ sync encrypted cookies
    ▼
CLI (scrape.ts)
    │
    ├── --local  → CloakBrowser (local, C++ fingerprint patches)
    │                 ├── navigator.webdriver → false (binary level)
    │                 ├── TLS fingerprint (JA3/JA4) → matches real Chrome
    │                 ├── Canvas/WebGL/audio → spoofed
    │                 ├── reCAPTCHA v3 score → 0.9 (human)
    │                 └── humanize: Bézier mouse, natural keyboard timing
    │
    └── default  → CF Worker (cloud, @cloudflare/puppeteer)
                      └── Browser Rendering binding
    │
    ▼
HTML / Markdown / text / screenshot
```

## Why three layers?

| Layer | Problem | Solution |
|-------|---------|----------|
| **Session** | Logged-out users trigger stricter WAF rules | CookieCloud syncs real browser cookies / Edge CDP extraction |
| **Fingerprint** | Headless Chrome is detectable via JS/Navigator/TLS | CloakBrowser patches Chromium at C++ level (49 patches) |
| **Behavior** | Linear mouse/instant typing = bot | CloakBrowser humanize: Bézier curves, natural keystroke timing |

CookieCloud alone can't hide `navigator.webdriver: true`. CloakBrowser alone can't log in. Together they cover all three.

## Quick start

```bash
git clone https://github.com/chrisprown902/cookiecloud-cf-scraper.git
cd cookiecloud-cf-scraper
npm install

# Copy .env.example → .env and fill in your values
cp .env.example .env
```

## Usage

### CF Worker mode (cloud, default)

```bash
# Deploy worker
npm run deploy

# Scrape
npm run scrape https://example.com --output markdown
npm run scrape https://example.com --output screenshot --out-file page.png
```

### CloakBrowser local mode (fingerprint hardened)

```bash
# Basic
npm run scrape:local https://example.com

# Humanize + headed (debug)
npx tsx scripts/scrape.ts https://example.com --local --humanize --headed

# Full loadout: proxy + persistent profile
npx tsx scripts/scrape.ts https://target.com \
  --local --humanize \
  --proxy socks5://user:pass@proxy:1080 \
  --profile ./profiles/my-bot \
  --output markdown
```

### CLI options

```
--output, -o    html | markdown | text | screenshot  (default: html)
--wait, -w      Wait for CSS selector
--timeout, -t   Page load timeout ms (default: 30000)
--header, -H    Extra HTTP header (key:value)
--out-file      Write output to file instead of stdout

CloakBrowser local mode:
--local         Use CloakBrowser instead of CF Worker
--humanize      Simulate human mouse/keyboard behavior
--headed        Show browser window (default: headless)
--proxy         Proxy URL (socks5:// or http://)
--profile       Persistent browser profile directory
```

## Cookie sources

The CLI tries cookie sources in order:

1. **Edge CDP** — extracts cookies directly from your local Edge browser via Chrome DevTools Protocol (start Edge with `msedge --remote-debugging-port=9222`)
2. **CookieCloud server** — pulls encrypted cookies from CookieCloud public instance or self-hosted server, decrypts locally
3. **No cookies** — falls back to cookieless scraping if both fail

## Setup

### CookieCloud

Install [CookieCloud](https://github.com/easychen/CookieCloud) browser extension, configure UUID + password, set in `.env`:

```env
COOKIECLOUD_URL=https://ccc.ft07.com
COOKIECLOUD_UUID=your-uuid
COOKIECLOUD_PASSWORD=your-password
```

### Edge CDP (alternative, no server needed)

```powershell
msedge --remote-debugging-port=9222
```

### CF Worker

```env
CLOUDFLARE_API_TOKEN=your-api-token
CLOUDFLARE_ACCOUNT_ID=your-account-id
CF_WORKER_URL=https://your-worker.workers.dev
```

### CloakBrowser

Auto-downloads ~200MB stealth Chromium binary on first launch. Cached at `~/.cloakbrowser/`. No additional config needed.

## When to use which backend

| Scenario | Backend |
|----------|---------|
| Low-frequency scraping, no login needed | CF Worker |
| Site has reCAPTCHA / Cloudflare Turnstile | CloakBrowser |
| High-frequency scraping, need proxy rotation | CloakBrowser + proxy |
| Server-side, unattended | CF Worker |
| Need drag/scroll/click simulation | CloakBrowser --humanize |

## How CloakBrowser differs from playwright-stealth

`playwright-stealth` injects JS patches at runtime — detectable by advanced fingerprinters. CloakBrowser modifies Chromium's C++ source before compilation, changing values at the binary level. `navigator.webdriver` is never set to `true` in the first place. TLS handshake matches real Chrome's cipher suite order exactly.

## License

MIT
