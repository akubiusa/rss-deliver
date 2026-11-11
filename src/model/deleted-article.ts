/**
 * An article that disappeared from a feed
 */
export interface DeletedArticle {
  /** Article identifier: the guid text, else the link, else the title */
  id: string
  /** Article title */
  title: string
  /** Article URL */
  link: string
  /** Publication date of the article */
  pubDate: string
  /** Detection time of the deletion (ISO 8601) */
  deletedAt: string
  /** Service class name */
  serviceName: string
}

/**
 * The whole deleted-articles history file
 */
export interface DeletedArticlesHistory {
  /** Schema version */
  version: string
  /** Last update time (ISO 8601) */
  lastUpdated: string
  /** Deleted articles */
  articles: DeletedArticle[]
}
