import { XMLParser } from 'fast-xml-parser'
import { Logger } from '@book000/node-utils'
import { Item } from '@/model/collect-result'
import { DeletedArticlesHistory } from '@/model/deleted-article'
import { getPubDateFromDeletedHistory } from './deleted-articles-tracker'

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
    }
  | undefined
>

// In-process cache to avoid fetching the same feed twice in a run
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
    Date.now() - feedCache[serviceName].lastFetched.getTime() < 3_600_000 // within 1 hour
  ) {
    logger.info(`🔄 Using cached feed for ${serviceName}`)
    return { status: 'ok', items: feedCache[serviceName].items }
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
      const itemsArray = parsePreviousFeed(await res.text())

      feedCache[serviceName] = {
        lastFetched: new Date(),
        items: itemsArray,
      }

      logger.info(`✅ Found ${itemsArray.length} previous items`)
      return { status: 'ok', items: itemsArray }
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
 * Inherits pubDate from the previous feed for an item that has none, falling back to the deleted-articles history.
 * Items are matched by ID (guid text, else link, else title).
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

  const itemId = (newItem.guid?.['#text'] ?? newItem.link) || newItem.title

  const previousItem = previousItems.find((item) => {
    const prevId = (item.guid?.['#text'] ?? item.link) || item.title
    return prevId === itemId
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

  // Found in neither: pubDate stays undefined
  return newItem
}
