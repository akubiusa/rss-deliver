import { XMLParser } from 'fast-xml-parser'
import fs from 'node:fs'
import { Logger } from '@book000/node-utils'
import { Item } from '@/model/collect-result'
import { DeletedArticlesHistory } from '@/model/deleted-article'
import {
  getItemId,
  getPubDateFromDeletedHistory,
} from '@/utils/deleted-articles-tracker'

interface RssItem {
  title: string
  link: string
  description?: string
  'content:encoded'?: string
  author?: string
  category?: string
  comments?: string
  enclosure?: string
  guid?: {
    '@_isPermaLink'?: boolean
    '#text'?: string
  }
  pubDate?: string
  source?: string
}

type PreviousFeedCache = Record<
  string,
  | {
      lastFetched: Date
      items: RssItem[]
      xml: string
    }
  | undefined
>

const feedCache: PreviousFeedCache = {}

/**
 * Result of loading the previous feed
 */
export interface PreviousFeedResult {
  /**
   * ok: loaded / not-found: 404 (not published yet) / error: network error, unexpected response or parse failure
   */
  status: 'ok' | 'not-found' | 'error'
  /** Previous items (empty unless status is ok) */
  items: RssItem[]
  /** Raw XML of the previous feed (set only when status is ok) */
  xml?: string
}

/**
 * Extracts the items from the XML of the previous feed.
 * `<item>` is inside `<channel>`, but the legacy format that put it outside `<channel>` (directly under `<rss>`) is also read.
 * @param xml XML of the previous feed
 * @returns Previous items
 * @throws If the XML is not an RSS document
 */
export function parsePreviousFeed(xml: string): RssItem[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
  })
  const parsed: {
    rss?: {
      channel?: {
        item?: RssItem | RssItem[]
      }
      item?: RssItem | RssItem[]
    }
  } = parser.parse(xml)
  if (parsed.rss === undefined) {
    throw new Error('Previous feed is not an RSS document')
  }
  const items = parsed.rss.channel?.item ?? parsed.rss.item ?? []

  // A single item is parsed as an object, not an array
  return Array.isArray(items) ? items : [items]
}

/**
 * Fetches the RSS feed published on GitHub Pages and reports whether it succeeded.
 * Successful results are cached in process for one hour.
 * @param serviceName Service class name (the feed is `<serviceName>.xml`)
 * @returns Load result
 */
export async function loadPreviousFeed(
  serviceName: string
): Promise<PreviousFeedResult> {
  const logger = Logger.configure('utils.getPreviousFeed')

  if (
    feedCache[serviceName] !== undefined &&
    Date.now() - feedCache[serviceName].lastFetched.getTime() < 3_600_000
  ) {
    logger.info(`🔄 Using cached feed for ${serviceName}`)
    return {
      status: 'ok',
      items: feedCache[serviceName].items,
      xml: feedCache[serviceName].xml,
    }
  }

  try {
    const feedUrl = `https://book000.github.io/rss-deliver/${serviceName}.xml`
    logger.info(`📥 Fetching previous feed from ${feedUrl}`)

    const res = await fetch(feedUrl, {
      signal: AbortSignal.timeout(10_000),
    })

    if (res.status === 404) {
      logger.warn(`❌ Previous feed not found: ${feedUrl}`)
      return { status: 'not-found', items: [] }
    }
    if (res.status !== 200) {
      logger.warn(`❌ Failed to fetch previous feed: ${res.status}`)
      return { status: 'error', items: [] }
    }

    try {
      const xml = await res.text()
      const itemsArray = parsePreviousFeed(xml)

      feedCache[serviceName] = {
        lastFetched: new Date(),
        items: itemsArray,
        xml,
      }

      logger.info(`✅ Found ${itemsArray.length} previous items`)
      return { status: 'ok', items: itemsArray, xml }
    } catch (error) {
      logger.error('❌ Failed to parse previous feed', error as Error)
      return { status: 'error', items: [] }
    }
  } catch (error) {
    logger.error('❌ Failed to fetch previous feed', error as Error)
    return { status: 'error', items: [] }
  }
}

/**
 * Fetches the RSS feed published on GitHub Pages.
 * @param serviceName Service class name
 * @returns Items of the previous feed, or an empty array on failure
 */
export async function getPreviousFeed(serviceName: string): Promise<RssItem[]> {
  const result = await loadPreviousFeed(serviceName)
  return result.items
}

/**
 * Copies the previously published feed to `output/<serviceName>.xml` unchanged, so that a failing service keeps its feed on the deployed site.
 * Writes nothing if the previous feed was never published or could not be loaded.
 * Never throws.
 * @param serviceName Service class name
 * @returns Whether the previous feed was written
 */
export async function carryOverPreviousFeed(
  serviceName: string
): Promise<boolean> {
  const logger = Logger.configure(`utils.carryOverPreviousFeed.${serviceName}`)

  const result = await loadPreviousFeed(serviceName)
  if (result.status !== 'ok' || result.xml === undefined) {
    logger.warn(
      `⚠️ No previous feed to carry over for ${serviceName} (${result.status})`
    )
    return false
  }

  try {
    fs.writeFileSync(`output/${serviceName}.xml`, result.xml)
  } catch (error) {
    logger.error(
      `❌ Failed to write carried-over feed for ${serviceName}`,
      error as Error
    )
    return false
  }

  logger.info(`📦 Carried over previous feed for ${serviceName}`)
  return true
}

/**
 * Inherits pubDate from the previous feed for an item that has none, falling back to the deleted-articles history.
 * Items are matched by ID.
 * @param newItem New item
 * @param previousItems Items of the previous feed
 * @param deletedHistory Deleted-articles history (optional)
 * @param serviceName Service name (for logging)
 * @returns The item, with pubDate set if one was found
 */
export function inheritPubDate(
  newItem: Item,
  previousItems: RssItem[],
  deletedHistory?: DeletedArticlesHistory | null,
  serviceName?: string
): Item {
  if (newItem.pubDate) {
    return newItem
  }

  const logger = Logger.configure(
    `utils.inheritPubDate${serviceName ? `.${serviceName}` : ''}`
  )

  const itemId = getItemId(newItem)

  const previousItem = previousItems.find((item) => {
    return getItemId(item) === itemId
  })

  if (previousItem?.pubDate) {
    return {
      ...newItem,
      pubDate: previousItem.pubDate,
    }
  }

  if (deletedHistory) {
    const deletedPubDate = getPubDateFromDeletedHistory(itemId, deletedHistory)
    if (deletedPubDate) {
      if (serviceName) {
        logger.info(
          `[${serviceName}] Restored pubDate from deletion history: ${newItem.title}`
        )
      }
      return {
        ...newItem,
        pubDate: deletedPubDate,
      }
    }
  }

  return newItem
}
