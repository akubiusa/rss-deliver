import { BaseService } from '@/base-service'
import { Logger } from '@book000/node-utils'
import * as cheerio from 'cheerio'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Selectors removed by default */
const DEFAULT_REMOVE_SELECTORS = [
  'header',
  'footer',
  '#headerArea',
  '#footerArea',
  '.breadcrumbs',
  '.leftNavigation-block',
  '.leftNavigation-bottom',
  '.leftNavigationInner',
  '.favoriteArea',
  '.anchorLink',
  '.local-footer',
  'script',
  'style',
  'noscript',
]

/** Default selector of the main content */
const DEFAULT_CONTENT_SELECTOR = '#mainArea'

/** Default HTTP request headers (imitating a browser) */
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  DNT: '1',
}

/** Default cache lifetime in milliseconds */
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Base directory of the cache */
const ARTICLE_CACHE_BASE_DIR = '.article-cache'

/**
 * Converts a class name to kebab-case.
 * @param name Class name (e.g. TdrUpdates)
 * @returns Kebab-case string (e.g. tdr-updates)
 */
function toKebabCase(name: string): string {
  return name
    .replaceAll(/([A-Z]+)([A-Z][a-z0-9])/g, '$1-$2')
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
}

/** Shape of a cache file */
interface ArticleCacheData {
  /** Article URL */
  url: string
  /** Extracted content HTML */
  content: string
  /** Fetch time (ISO 8601) */
  fetchedAt: string
}

/**
 * Extracts the main content from the HTML of an article page.
 * Removes the header, footer, navigation and similar, and returns the HTML of the main area (the whole body if the selector matches nothing).
 * @param html HTML of the page
 * @param contentSelector Selector of the main content (default: '#mainArea')
 * @param removeSelectors Selectors to remove (default: common noise elements)
 * @returns Extracted content HTML
 */
export function extractArticleContent(
  html: string,
  contentSelector: string = DEFAULT_CONTENT_SELECTOR,
  removeSelectors: string[] = DEFAULT_REMOVE_SELECTORS
): string {
  const $ = cheerio.load(html)

  for (const selector of removeSelectors) {
    $(selector).remove()
  }

  const mainArea = $(contentSelector)
  return mainArea.length > 0
    ? (mainArea.html() ?? '')
    : ($('body').html() ?? '')
}

/**
 * Fetches the content of an article page with an on-disk cache.
 * Returns the cached content if it exists and has not expired; otherwise fetches the page and stores the result.
 * Empty content is not cached so that the next run fetches it again.
 * The cache directory is `.article-cache/<kebab-case service class name>`.
 * @param url URL of the article page
 * @param service Service instance used to derive the cache directory
 * @param logger Logger
 * @param options Options
 * @param options.headers HTTP request headers (default: browser-like headers)
 * @param options.contentSelector Selector of the main content (default: '#mainArea')
 * @param options.removeSelectors Selectors to remove (default: common noise elements)
 * @param options.cacheTtlMs Cache lifetime in milliseconds (default: 7 days)
 * @returns HTML of the main content of the article page
 * @throws If the page responds with a status other than 200
 */
export async function fetchArticleWithCache(
  url: string,
  service: BaseService,
  logger: Logger,
  options: {
    headers?: Record<string, string>
    contentSelector?: string
    removeSelectors?: string[]
    cacheTtlMs?: number
  } = {}
): Promise<string> {
  const cacheDir = path.join(
    ARTICLE_CACHE_BASE_DIR,
    toKebabCase(service.constructor.name)
  )
  const urlHash = crypto.createHash('sha256').update(url).digest('hex')
  const cachePath = path.join(cacheDir, `${urlHash}.json`)
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS

  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(
        fs.readFileSync(cachePath, 'utf8')
      ) as ArticleCacheData
      const cachedAt = new Date(cached.fetchedAt).getTime()
      if (Date.now() - cachedAt < cacheTtlMs) {
        logger.info(`📦 Using article cache: ${url}`)
        return cached.content
      }
      logger.info(`⏰ Article cache expired, re-fetching: ${url}`)
    } catch {
      // Ignore a broken cache and fetch again
      logger.warn(`⚠️ Failed to read cache, re-fetching: ${cachePath}`)
      try {
        fs.unlinkSync(cachePath)
      } catch {
        // Failing to delete is not fatal
      }
    }
  }

  logger.info(`🌐 Fetching article page: ${url}`)
  const res = await fetch(url, {
    headers: options.headers ?? DEFAULT_HEADERS,
  })
  if (res.status !== 200) {
    throw new Error(`Failed to fetch article: ${res.status} ${url}`)
  }

  const content = extractArticleContent(
    await res.text(),
    options.contentSelector,
    options.removeSelectors
  )

  // Do not cache empty content so that the next run fetches it again
  if (!content.trim()) {
    logger.warn(`⚠️ Empty content extracted, skipping cache: ${url}`)
    return content
  }

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true })
  }
  const cacheData: ArticleCacheData = {
    url,
    content,
    fetchedAt: new Date().toISOString(),
  }
  fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2))

  return content
}
