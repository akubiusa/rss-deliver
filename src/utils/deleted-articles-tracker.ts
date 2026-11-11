import { Logger } from '@book000/node-utils'
import { Item } from '@/model/collect-result'
import { DeletedArticle, DeletedArticlesHistory } from '@/model/deleted-article'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

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

// URL of the history file on GitHub Pages
const DELETED_ARTICLES_HISTORY_URL =
  'https://book000.github.io/rss-deliver/deleted-articles-history.json'

/**
 * Returns the unique ID of an article: the guid text, else the link, else the title.
 */
function getItemId(item: RssItem | Item): string {
  return (item.guid?.['#text'] ?? item.link) || item.title
}

/**
 * Fetches the deleted-articles history from GitHub Pages.
 * @returns The history, or null if it could not be fetched
 */
export async function fetchDeletedArticlesHistory(): Promise<DeletedArticlesHistory | null> {
  const logger = Logger.configure('utils.fetchDeletedArticlesHistory')

  try {
    // Cache buster
    const res = await fetch(`${DELETED_ARTICLES_HISTORY_URL}?t=${Date.now()}`, {
      signal: AbortSignal.timeout(10_000),
    })

    if (res.status !== 200) {
      logger.warn(`❌ Failed to fetch deleted articles history: ${res.status}`)
      return null
    }

    const data = (await res.json()) as DeletedArticlesHistory
    logger.info(
      `✅ Fetched deleted articles history with ${data.articles.length} articles`
    )
    return data
  } catch (error) {
    logger.error('❌ Failed to fetch deleted articles history', error as Error)
    return null
  }
}

/**
 * Detects articles that were in the previous feed but are missing from the current one.
 * @param previousItems Items of the previous feed
 * @param currentItems Items collected in this run
 * @param serviceName Service class name
 * @returns Deleted articles
 */
export function detectDeletedArticles(
  previousItems: RssItem[],
  currentItems: Item[],
  serviceName: string
): DeletedArticle[] {
  const logger = Logger.configure(`utils.detectDeletedArticles.${serviceName}`)

  const currentIds = new Set(currentItems.map((item) => getItemId(item)))

  const deletedArticles = previousItems
    .filter((item) => !currentIds.has(getItemId(item)))
    .map((item) => ({
      id: getItemId(item),
      title: item.title,
      link: item.link,
      pubDate: item.pubDate ?? new Date().toISOString(),
      deletedAt: new Date().toISOString(),
      serviceName,
    }))

  if (deletedArticles.length > 0) {
    logger.info(`🗑️ Detected ${deletedArticles.length} deleted articles`)
    for (const article of deletedArticles) {
      logger.info(`[${serviceName}] Detected deleted article: ${article.title}`)
    }
  }

  return deletedArticles
}

/**
 * Removes history entries whose deletion was detected more than 30 days ago.
 */
export function cleanupDeletedArticlesHistory(
  history: DeletedArticlesHistory
): DeletedArticlesHistory {
  const logger = Logger.configure('utils.cleanupDeletedArticlesHistory')
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  const originalCount = history.articles.length
  const cleanedArticles = history.articles.filter((article) => {
    const deletedAt = new Date(article.deletedAt)
    return deletedAt >= thirtyDaysAgo
  })

  const removedCount = originalCount - cleanedArticles.length
  if (removedCount > 0) {
    logger.info(`🧹 Cleaned up ${removedCount} articles older than 30 days`)
  }

  return {
    ...history,
    articles: cleanedArticles,
  }
}

/**
 * Adds newly deleted articles to the history (skipping IDs already recorded) and cleans up old entries.
 * @param currentHistory Current history, or null if there is none
 * @param newDeletedArticles Articles detected as deleted in this run
 * @returns Updated history
 */
export function updateDeletedArticlesHistory(
  currentHistory: DeletedArticlesHistory | null,
  newDeletedArticles: DeletedArticle[]
): DeletedArticlesHistory {
  const logger = Logger.configure('utils.updateDeletedArticlesHistory')

  if (!currentHistory) {
    logger.info('📄 Creating new deleted articles history')
    return {
      version: '1.0',
      lastUpdated: new Date().toISOString(),
      articles: newDeletedArticles,
    }
  }

  const existingIds = new Set(
    currentHistory.articles.map((article) => article.id)
  )

  const newArticles = newDeletedArticles.filter(
    (article) => !existingIds.has(article.id)
  )

  if (newArticles.length > 0) {
    logger.info(
      `📝 Adding ${newArticles.length} new deleted articles to history`
    )
  }

  const updatedHistory = {
    version: '1.0',
    lastUpdated: new Date().toISOString(),
    articles: [...currentHistory.articles, ...newArticles],
  }

  return cleanupDeletedArticlesHistory(updatedHistory)
}

/**
 * Writes the history to `output/deleted-articles-history.json`.
 */
export function saveDeletedArticlesHistory(
  history: DeletedArticlesHistory
): void {
  const logger = Logger.configure('utils.saveDeletedArticlesHistory')

  try {
    const outputPath = path.join(
      process.cwd(),
      'output',
      'deleted-articles-history.json'
    )
    writeFileSync(outputPath, JSON.stringify(history, null, 2))
    logger.info(`💾 Saved deleted articles history to ${outputPath}`)
  } catch (error) {
    logger.error('❌ Failed to save deleted articles history', error as Error)
  }
}

/**
 * Looks up the pubDate of an article in the history.
 * @returns The pubDate, or undefined if the article is not in the history
 */
export function getPubDateFromDeletedHistory(
  itemId: string,
  history: DeletedArticlesHistory | null
): string | undefined {
  if (!history) {
    return undefined
  }

  const deletedArticle = history.articles.find(
    (article) => article.id === itemId
  )
  return deletedArticle?.pubDate
}
