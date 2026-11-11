import { BaseService } from '@/base-service'
import CollectResult, { Item } from '@/model/collect-result'
import ServiceInformation from '@/model/service-information'
import { fetchArticleWithCache } from '@/utils/article-fetcher'
import { Logger } from '@book000/node-utils'
import * as cheerio from 'cheerio'

export default class FF14LodestoneMaintenance extends BaseService {
  /**
   * Returns the feed metadata.
   * @returns Feed title, link, description and related channel fields
   */
  information(): ServiceInformation {
    return {
      title: 'FF14 Lodestone Maintenance',
      link: 'https://jp.finalfantasyxiv.com/lodestone/',
      description: 'Maintenance - FINAL FANTASY XIV, The Lodestone',

      generator: 'book000/rss-deliver',
      language: 'ja',
    }
  }

  /**
   * Collects the FF14 Lodestone maintenance list.
   * The content of each article page is fetched through the on-disk article cache.
   * @returns Collected items and status
   */
  async collect(): Promise<CollectResult> {
    const logger = Logger.configure('FF14LodestoneMaintenance::collect')
    const res = await fetch('https://jp.finalfantasyxiv.com/lodestone/')
    const data = await res.text()
    if (res.status !== 200 && data.includes('メンテナンス中')) {
      logger.info('🚧 FF14 Lodestone is under maintenance')
      return {
        status: false,
        items: [],
      }
    }
    if (res.status !== 200) {
      throw new Error(`Failed to fetch: ${res.status}`)
    }

    const $ = cheerio.load(data)
    const items: Item[] = []
    /*
      -: Latest
      1: Topics
      2: Notices
      3: Maintenance
      4: Updates
      5: Obstacles (service incidents)
    */
    const maintenance = $(
      '#toptabchanger_newsarea > div.toptabchanger_newsbox:nth-child(3) li.news__list a'
    )
    for (const index of maintenance.slice(0, 10)) {
      const item = $(index)
      const title = item.find('p').text()
      const link = 'https://jp.finalfantasyxiv.com' + (item.attr('href') ?? '')

      let text: string
      try {
        text = await fetchArticleWithCache(link, this, logger, {
          contentSelector: 'div.news__detail__wrapper',
        })
      } catch (error) {
        logger.error(
          `❌ Failed to fetch article content: ${link}`,
          error as Error
        )
        text = `<p>${title}</p>`
      }

      items.push({
        title,
        link,
        'content:encoded': text,
      })
    }

    return {
      status: true,
      items,
    }
  }
}
