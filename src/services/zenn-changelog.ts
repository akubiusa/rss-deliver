import { BaseService } from '@/base-service'
import CollectResult, { Item } from '@/model/collect-result'
import ServiceInformation from '@/model/service-information'
import { fetchArticleWithCache } from '@/utils/article-fetcher'
import { Logger } from '@book000/node-utils'
import { XMLParser } from 'fast-xml-parser'

interface LinkClass {
  _href: string
  _rel: string
  _type: string
  __prefix: string
}

interface GUID {
  _isPermaLink: string
  __text: string
}

interface Enclosure {
  _url: string
  _length: string
  _type: string
}

interface Creator {
  __prefix: 'dc'
  __text: 'Zenn Team'
}

interface ChannelItem {
  title: string
  link: string
  guid: GUID
  pubDate: string
  creator: Creator
  description?: string
  enclosure?: Enclosure
}

interface Image {
  url: string
  title: string
  link: string
}

interface Channel {
  title: string
  description: string
  link: (LinkClass | string)[]
  image: Image
  generator: string
  lastBuildDate: string
  language: string
  item: ChannelItem[]
}

interface RSS {
  channel: Channel
  '_xmlns:dc': string
  '_xmlns:content': string
  '_xmlns:atom': string
  _version: string
}

interface ZeenChangelogResponse {
  rss: RSS
}

export default class ZennChangelog extends BaseService {
  /**
   * Returns the feed metadata.
   * @returns Feed metadata
   */
  information(): ServiceInformation {
    return {
      title: 'Zenn Changelog',
      link: 'https://info.zenn.dev',
      description: "What's new on zenn.dev",

      image: {
        url: 'https://zenn.dev/images/logo-only-dark.png',
        title: 'Zenn Changelog',
        link: 'https://info.zenn.dev',
      },
      generator: 'book000/rss-deliver',
      language: 'ja',
    }
  }

  /**
   * Collects the Zenn Changelog entries.
   * Article pages are fetched through the on-disk article cache; on failure the RSS description is used as a fallback.
   * @returns Collected items and status
   */
  async collect(): Promise<CollectResult> {
    const logger = Logger.configure('ZennChangelog::collect')
    const parser = new XMLParser({
      ignoreAttributes: false,
    })
    const res = await fetch('https://info.zenn.dev/rss/feed.xml')
    if (res.status !== 200) {
      return {
        status: false,
        items: [],
      }
    }
    const oldFeed: ZeenChangelogResponse = parser.parse(await res.text())
    const items: Item[] = []
    for (const item of oldFeed.rss.channel.item.slice(0, 10)) {
      const link: string = item.link
      const itemUrl = `https://info.zenn.dev/${link.split('/').pop() ?? ''}`

      let content: string
      try {
        content = await fetchArticleWithCache(itemUrl, this, logger, {
          contentSelector: '[class^="SlugPage_blogBody"]',
        })
      } catch (error) {
        logger.warn(
          `⚠️ Failed to fetch article content, using description: ${itemUrl}`,
          error as Error
        )
        content = item.description ?? ''
      }

      if (!content.trim()) {
        content = item.description ?? ''
      }

      items.push({
        title: item.title,
        link,
        pubDate: item.pubDate,
        'content:encoded': content,
      })
    }
    return {
      status: true,
      items,
    }
  }
}
