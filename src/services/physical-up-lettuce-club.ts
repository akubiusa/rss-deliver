import { BaseService } from '@/base-service'
import { Logger } from '@book000/node-utils'
import CollectResult, { Item } from '@/model/collect-result'
import ServiceInformation from '@/model/service-information'
import * as cheerio from 'cheerio'

export default class PhysicalUpLettuceClub extends BaseService {
  information(): ServiceInformation {
    return {
      title: '体力アップ1年生',
      link: 'https://www.lettuceclub.net/news/serial/11656/',
      description: '体力アップ1年生 | レタスクラブ',

      image: {
        url: 'https://www.lettuceclub.net/i/N1/matome/11656/1621994268.jpg',
        title: '体力アップ1年生',
        link: 'https://www.lettuceclub.net/news/serial/11656/',
      },
      generator: 'book000/rss-deliver',
      language: 'ja',
    }
  }

  async collect(): Promise<CollectResult> {
    const logger = Logger.configure('PhysicalUpLettuceClub::collect')
    const res = await fetch('https://www.lettuceclub.net/news/serial/11656/')
    if (!res.ok) {
      throw new Error(`Failed to fetch: ${res.status}`)
    }
    const $ = cheerio.load(await res.text())
    const items: Item[] = []
    const seenLinks = new Set<string>()
    // The grid view and the "latest episode" highlight view use the same link format,
    // so collect from the whole list instead of per display block
    for (const index of $('a[href*="/news/article/"]')) {
      const item = $(index)
      const href = item.attr('href') ?? ''
      if (!href.includes('article')) {
        continue
      }
      let link = 'https://www.lettuceclub.net' + href
      if (link.endsWith('display/')) {
        link = link.replace('display/', '')
      }
      if (seenLinks.has(link)) {
        continue
      }
      seenLinks.add(link)

      // In the grid view, the title <p> follows the genre tag <p>
      const title = item.find('p').last().text().trim()

      const content = await this.getContent(link)
      if (!content) {
        continue
      }
      const images = content.images
      const pubDate = content.pubDate

      logger.info(`📃 ${title} ${link}`)
      logger.info(`📅 ${pubDate}`)
      logger.info(`🎨 ${images.toString()}`)

      items.push({
        title,
        link,
        'content:encoded': images
          .map((index) => `<img src="${index}">`)
          .join('<br>'),
        pubDate,
      })
    }
    return {
      status: true,
      items,
    }
  }

  async getContent(url: string): Promise<{
    images: string[]
    pubDate: string
  } | null> {
    const res = await fetch(url)
    if (res.status !== 200) {
      return null
    }
    const $ = cheerio.load(await res.text())

    // Keep only images whose URL contains the article ID, to exclude figure/img of ads and related products
    const articleId = /\/article\/(\d+)\//.exec(url)?.[1]

    const images: string[] = []
    for (const index of $('figure img')) {
      const src = $(index).attr('src') ?? ''
      if (!src.startsWith('https')) {
        continue
      }
      if (articleId && !src.includes(`/i/N1/${articleId}/`)) {
        continue
      }
      images.push(src)
    }

    // The ranking widget at the bottom also has a <time>, so use the first one
    const rawPubDate = $('time[datetime*="T"]').first().attr('datetime') ?? ''
    const pubDate = rawPubDate ? new Date(rawPubDate).toUTCString() : ''
    return {
      images,
      pubDate,
    }
  }
}
