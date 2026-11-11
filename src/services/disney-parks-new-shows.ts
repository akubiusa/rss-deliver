import { BaseService } from '@/base-service'
import CollectResult, { Item } from '@/model/collect-result'
import ServiceInformation from '@/model/service-information'
import { getItemId } from '@/utils/deleted-articles-tracker'
import { loadPreviousFeed } from '@/utils/previous-feed'
import { findNewShowEvidence } from '@/utils/show-classifier'
import { Logger } from '@book000/node-utils'
import * as cheerio from 'cheerio'
import { XMLParser } from 'fast-xml-parser'

const ONE_DAY_MS = 86_400_000

/**
 * Maximum age in days (from the publication date) of an article of this run to be listed as new.
 * Applied every run, because some sources, such as the Oriental Land list, return all past articles.
 */
const NEW_ARTICLE_DAYS = 7

/** Maximum age in days (from the publication date) of a previous item to be carried over */
const RETENTION_DAYS = 90

/** Maximum length of the summary in characters */
const SUMMARY_MAX_LENGTH = 300

/** Browser-like headers, because sites behind Akamai reject curl-like clients */
const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
}

/**
 * One official news article in a common format, before classification.
 */
export interface Candidate {
  /** Region or park name */
  region: string
  /** Original title of the official article */
  title: string
  /** URL of the official article */
  link: string
  /** Publication time (undefined if unavailable or unparsable) */
  pubDate: Date | undefined
  /** Plain-text summary (empty string if none) */
  summary: string
  /** Plain text of the body (empty string if none) */
  bodyText: string
}

/**
 * A source of official news.
 */
export interface SourceFetcher {
  /** Name of the source, used in logs */
  name: string
  /** Fetches the candidate articles. Throws on failure */
  fetch: () => Promise<Candidate[]>
}

/**
 * The elements of a standard WordPress RSS `item` that are used (the value types are not fixed in the XML parse result)
 */
interface WordPressItem {
  title?: unknown
  link?: unknown
  pubDate?: unknown
  description?: unknown
  'content:encoded'?: unknown
  category?: unknown[]
}

/**
 * The part of the parse result of a standard WordPress RSS that is used
 */
interface WordPressFeed {
  rss?: {
    channel?: {
      item?: WordPressItem[]
    }
  }
}

/**
 * Strips tags from an HTML string and collapses whitespace.
 * @param html HTML string
 * @returns Plain text (empty string if the input is not a non-empty string)
 */
function toPlainText(html: unknown): string {
  return typeof html !== 'string' || html === ''
    ? ''
    : cheerio.load(html).text().replaceAll(/\s+/g, ' ').trim()
}

/**
 * Converts an XML parse result (string or number) to a trimmed string.
 * @param value Parse result
 * @returns The string, or an empty string if the value is neither a string nor a number
 */
function toText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : ''
}

/**
 * Truncates a string to a maximum length, stepping back one character if the cut splits a surrogate pair.
 * @param text String
 * @param maxLength Maximum length
 * @returns Truncated string
 */
function truncate(text: string, maxLength: number): string {
  const cut = text.slice(0, maxLength)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

/**
 * Converts a date string to a Date.
 * @param value Date string
 * @returns A Date, or undefined if it cannot be parsed
 */
function toDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/**
 * Determines the region name from the categories of a Disney Parks Blog article.
 * Returns undefined for articles without a category of a target resort (cruises, etc.).
 * @param categories Categories of the article
 * @returns Region name; joined with `, ` if the article spans several resorts
 */
export function resolveDpbRegion(categories: string[]): string | undefined {
  const regions: string[] = []
  if (
    categories.some((category) => category.includes('Walt Disney World Resort'))
  ) {
    regions.push('Walt Disney World Resort (Florida)')
  }
  if (categories.some((category) => category.includes('Disneyland Resort'))) {
    regions.push('Disneyland Resort (California)')
  }
  return regions.length > 0 ? regions.join(', ') : undefined
}

/**
 * Converts a standard WordPress RSS 2.0 feed to candidates.
 * @param xml RSS XML string
 * @param region Region name. If a function, it determines the region from the categories, and articles for which it returns undefined are excluded
 * @returns Candidates
 */
export function parseWordPressFeed(
  xml: string,
  region: string | ((categories: string[]) => string | undefined)
): Candidate[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    htmlEntities: true,
    isArray: (name) => name === 'item' || name === 'category',
  })
  const feed = parser.parse(xml) as WordPressFeed
  const candidates: Candidate[] = []
  const items = feed.rss?.channel?.item ?? []
  for (const item of items) {
    const categories = (item.category ?? []).map((category) => toText(category))
    const regionName = typeof region === 'string' ? region : region(categories)
    if (regionName === undefined) {
      continue
    }
    candidates.push({
      region: regionName,
      title: toText(item.title),
      link: toText(item.link),
      pubDate: toDate(item.pubDate),
      summary: toPlainText(item.description),
      bodyText: toPlainText(item['content:encoded']),
    })
  }
  return candidates
}

/**
 * Converts the Oriental Land news release list (HTML) to candidates.
 * The list has no summary or body, so only the title is used.
 * @param html HTML of the list page
 * @param baseUrl Base URL for resolving relative URLs
 * @returns Candidates
 */
export function parseOlcHtml(html: string, baseUrl: string): Candidate[] {
  const $ = cheerio.load(html)
  const candidates: Candidate[] = []
  for (const element of $('li[entrydate]')) {
    const entry = $(element)
    const href = entry.find('a').first().attr('href') ?? ''
    let link = href
    try {
      link = new URL(href, baseUrl).href
    } catch {
      // Keep an unresolvable URL as is; it is dropped later by the URL validation
    }
    const date = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(
      entry.attr('entrydate') ?? ''
    )
    candidates.push({
      region: 'Tokyo Disney Resort',
      title: entry.find('.news_tx').first().text().trim(),
      link,
      pubDate: date
        ? toDate(`${date[1]}-${date[2]}-${date[3]}T00:00:00+09:00`)
        : undefined,
      summary: '',
      bodyText: '',
    })
  }
  return candidates
}

/**
 * Normalizes a URL used to identify an article (drops query, hash and trailing slashes).
 * Used for comparison only, never for the output URL.
 * @param link Article URL
 * @returns Normalized URL, or the input if it is not a valid URL
 */
function normalizeLink(link: string): string {
  try {
    const url = new URL(link)
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return link
  }
}

/**
 * Returns the identifier of an item (`getItemId`) with its link normalized.
 * @param item Item
 * @returns Normalized identifier
 */
function getItemKey(item: Item): string {
  return normalizeLink(getItemId(item))
}

/**
 * Returns whether the item was published within N days. An unparsable pubDate yields false.
 * @param item Item
 * @param now Current time
 * @param days Number of days
 * @returns true if `now - pubDate <= days × 24 hours`
 */
function isWithinDays(item: Item, now: Date, days: number): boolean {
  const published = Date.parse(item.pubDate ?? '')
  return now.getTime() - published <= days * ONE_DAY_MS
}

/**
 * Merges the items of this run with the previous items.
 *
 * Items of this run published more than 7 days ago are not listed, even on the first run (to avoid delivering all past articles at once).
 * Previous items that are not in this run are carried over if published within 90 days.
 * An item with the same identifier is overwritten by the one of this run. The result is sorted by publication date, newest first (by link, ascending, on a tie).
 * @param current Items of this run
 * @param previous Previous items
 * @param now Current time
 * @returns Merged and sorted items
 */
export function mergeItems(
  current: Item[],
  previous: Item[],
  now: Date
): Item[] {
  const merged = new Map<string, Item>()
  for (const item of previous) {
    if (isWithinDays(item, now, RETENTION_DAYS)) {
      merged.set(getItemKey(item), item)
    }
  }
  for (const item of current) {
    if (isWithinDays(item, now, NEW_ARTICLE_DAYS)) {
      merged.set(getItemKey(item), item)
    }
  }
  return merged
    .values()
    .toArray()
    .toSorted((a, b) => {
      const diff = Date.parse(b.pubDate ?? '') - Date.parse(a.pubDate ?? '')
      if (diff !== 0) {
        return diff
      }
      return a.link < b.link ? -1 : a.link > b.link ? 1 : 0
    })
}

/**
 * Creates the sources of official news.
 * @returns Fetchers of the official news sources
 */
function createSources(): SourceFetcher[] {
  const fetchText = async (url: string, timeoutMs: number): Promise<string> => {
    const res = await fetch(url, {
      headers: REQUEST_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status !== 200) {
      throw new Error(`Failed to fetch ${url}: ${res.status}`)
    }
    return res.text()
  }
  const olcUrl = 'https://www.olc.co.jp/ja/news.html'
  return [
    {
      name: 'Disney Parks Blog',
      fetch: async () =>
        parseWordPressFeed(
          await fetchText(
            'https://disneyparks.disney.go.com/blog/feed/',
            30_000
          ),
          resolveDpbRegion
        ),
    },
    {
      name: 'Disneyland Paris News',
      fetch: async () =>
        parseWordPressFeed(
          await fetchText('https://news.disneylandparis.com/feed/', 30_000),
          'Disneyland Paris'
        ),
    },
    {
      name: 'Hong Kong Disneyland Resort Press Room',
      fetch: async () =>
        parseWordPressFeed(
          await fetchText(
            'https://news.hongkongdisneyland.com/en/feed/',
            30_000
          ),
          'Hong Kong Disneyland Resort'
        ),
    },
    {
      name: 'Shanghai Disney Resort Corporate Site',
      fetch: async () =>
        parseWordPressFeed(
          await fetchText(
            'https://shcorporate.shanghaidisneyresort.com/en/feed/',
            60_000
          ),
          'Shanghai Disney Resort'
        ),
    },
    {
      name: 'Oriental Land News Release',
      fetch: async () => parseOlcHtml(await fetchText(olcUrl, 30_000), olcUrl),
    },
  ]
}

/**
 * Returns whether the string is an http or https URL.
 * @param link URL string
 * @returns true for an http or https URL
 */
function isHttpUrl(link: string): boolean {
  try {
    const { protocol } = new URL(link)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Collects articles on new shows and parades from the official news of Disney parks worldwide.
 */
export default class DisneyParksNewShows extends BaseService {
  /**
   * Returns the feed metadata.
   * @returns Feed metadata
   */
  information(): ServiceInformation {
    return {
      title: 'Disney Parks New Shows & Parades',
      link: 'https://github.com/book000/rss-deliver',
      description:
        'New shows and parades announced in official news of Disney parks worldwide',
      generator: 'book000/rss-deliver',
      language: 'en',
    }
  }

  /**
   * Collects the official news and merges it with the previous feed.
   * @returns Collected items and status
   */
  async collect(): Promise<CollectResult> {
    const logger = Logger.configure(`${this.constructor.name}.collect`)
    const previous = await loadPreviousFeed(this.constructor.name)
    if (previous.status === 'error') {
      // Publishing without the previous items would lose articles that are outside the window of this run, so do not update this time
      logger.warn('❌ Failed to load the previous feed. Skipping this run')
      return { status: false, items: [] }
    }
    return this.collectFrom(createSources(), previous.items, new Date())
  }

  /**
   * Fetches the official news of each source and merges the articles on new shows and parades with the previous items.
   * A failing source (an exception or zero articles) does not affect the others; status is false only if all sources fail.
   * @param sources Sources
   * @param previousItems Previous items
   * @param now Current time
   * @returns Collected items and status
   */
  async collectFrom(
    sources: SourceFetcher[],
    previousItems: Item[],
    now: Date
  ): Promise<CollectResult> {
    const logger = Logger.configure(`${this.constructor.name}.collectFrom`)

    const results = await Promise.allSettled(
      sources.map((source) => source.fetch())
    )
    const candidates: Candidate[] = []
    let succeeded = 0
    for (const [index, result] of results.entries()) {
      const name = sources[index].name
      if (result.status === 'rejected') {
        logger.warn(
          `❌ Failed to collect ${name}`,
          result.reason instanceof Error ? result.reason : undefined
        )
        continue
      }
      if (result.value.length === 0) {
        logger.warn(`❌ No articles extracted from ${name}`)
        continue
      }
      logger.info(`📥 ${name}: ${result.value.length} articles`)
      succeeded++
      candidates.push(...result.value)
    }
    if (succeeded === 0) {
      logger.warn('❌ All sources failed')
      return { status: false, items: [] }
    }

    const grouped = new Map<
      string,
      { candidate: Candidate; regions: string[] }
    >()
    for (const candidate of candidates) {
      if (candidate.pubDate === undefined || !isHttpUrl(candidate.link)) {
        logger.warn(
          `⚠️ Dropped an article without a valid date or url: ${candidate.title}`
        )
        continue
      }
      const evidence = findNewShowEvidence(candidate)
      if (evidence === undefined) {
        continue
      }
      logger.info(
        `🎭 Matched ${JSON.stringify(candidate.title)} (${JSON.stringify(evidence)})`
      )
      const key = normalizeLink(candidate.link)
      const existing = grouped.get(key)
      if (existing) {
        if (!existing.regions.includes(candidate.region)) {
          existing.regions.push(candidate.region)
        }
        continue
      }
      grouped.set(key, { candidate, regions: [candidate.region] })
    }

    const currentItems: Item[] = grouped
      .values()
      .map(({ candidate, regions }) => {
        const label = regions.join(', ')
        const summary = truncate(candidate.summary, SUMMARY_MAX_LENGTH)
        return {
          title: candidate.title,
          link: candidate.link,
          description: `[${label}] ${summary}`.trim(),
          category: label,
          guid: { '#text': candidate.link },
          pubDate: candidate.pubDate?.toUTCString(),
        }
      })
      .toArray()

    const unparsable = previousItems.filter((item) =>
      Number.isNaN(Date.parse(item.pubDate ?? ''))
    )
    if (unparsable.length > 0) {
      logger.warn(
        `⚠️ ${unparsable.length} previous items have an invalid pubDate and are not carried over`
      )
    }
    const items = mergeItems(currentItems, previousItems, now)
    logger.info(
      `✅ ${currentItems.length} matched articles, ${items.length} items after merging with ${previousItems.length} previous items`
    )
    return { status: true, items }
  }
}
