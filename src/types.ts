/** CookieCloud 解密后返回的原始 Cookie 对象 */
export interface CookieCloudCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  sameSite?: string;
  expirationDate?: number;
  httpOnly?: boolean;
  secure?: boolean;
  hostOnly?: boolean;
}

/** 转换后给 Puppeteer 用的 Cookie 格式 */
export interface PuppeteerCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  sameSite: 'Strict' | 'Lax' | 'None';
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

/** CookieCloud API 返回的解密数据结构 */
export interface CookieCloudData {
  cookie_data: Record<string, CookieCloudCookie[]>;
  local_storage_data: Record<string, Record<string, string>>;
}

/** Worker 请求体 */
export interface ScrapeRequest {
  url: string;
  cookies: PuppeteerCookie[];
  options?: ScrapeOptions;
}

export interface ScrapeOptions {
  /** 等待特定 CSS 选择器出现后再提取 */
  waitSelector?: string;
  /** 额外等待时间 (ms)，在 waitSelector 之后 */
  waitTimeout?: number;
  /** 输出格式，默认 html */
  output?: 'html' | 'markdown' | 'text' | 'screenshot';
  /** 页面导航超时 (ms)，默认 30000 */
  timeout?: number;
  /** 额外的 HTTP headers */
  extraHeaders?: Record<string, string>;
}

/** Worker 响应体 */
export interface ScrapeResponse {
  success: boolean;
  url: string;
  output: string; // base64 for screenshot, text otherwise
  contentType: string;
  error?: string;
  /** 是否被反爬拦截 */
  blocked?: boolean;
}
