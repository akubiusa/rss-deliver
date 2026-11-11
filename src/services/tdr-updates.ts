import { BaseService } from '@/base-service'
import { Logger } from '@book000/node-utils'
import CollectResult, { Item } from '@/model/collect-result'
import ServiceInformation from '@/model/service-information'
import { fetchArticleWithCache } from '@/utils/article-fetcher'
import * as cheerio from 'cheerio'
import crypto from 'node:crypto'
import fs from 'node:fs'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas } from 'canvas'

export default class TdrUpdates extends BaseService {
  private readonly pageUrl =
    'https://www.tokyodisneyresort.jp/tdr/news/update.html'

  /**
   * Returns the feed metadata.
   * @returns Feed metadata
   */
  information(): ServiceInformation {
    return {
      title: 'サイト更新情報 | 東京ディズニーリゾート',
      link: this.pageUrl,
      description: '東京ディズニーリゾート「サイト更新情報」をご案内します。',
      generator: 'book000/rss-deliver',
      language: 'ja',
    }
  }

  /**
   * Collects the site update notices of Tokyo Disney Resort.
   * Article pages are fetched through the on-disk article cache; PDFs are rendered to PNG images.
   * @returns Collected items and status
   */
  async collect(): Promise<CollectResult> {
    const logger = Logger.configure('TdrUpdates::collect')
    const res = await fetch(this.pageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        DNT: '1',
      },
    })
    if (!res.ok) {
      throw new Error(`Failed to fetch: ${res.status}`)
    }
    const $ = cheerio.load(await res.text())
    const items: Item[] = []
    for (const element of $('div.listUpdate ul li a')) {
      const anchor = $(element)
      const href = anchor.attr('href') ?? ''
      const url = new URL(href, this.pageUrl).href
      const title = anchor.find('p.txt').text()
      const dateRaw = anchor.find('p.date').text() // 2023.7.24 更新情報
      const year = ('0000' + dateRaw.split('.', 1)[0]).slice(-4)
      const month = ('00' + dateRaw.split('.', 2)[1]).slice(-2)
      const day = ('00' + dateRaw.split('.', 3)[2].split(' ', 1)[0]).slice(-2)
      const date = new Date(`${year}-${month}-${day}T00:00:00+09:00`)

      logger.info(`📃 ${title} ${url} (${year}/${month}/${day})`)

      const category = anchor.find('span.iconTag').text().trim()

      let content: string
      if (url.endsWith('.pdf')) {
        const pdfUrls = await this.pdf2png(url)
        content = pdfUrls.map((pdfUrl) => `<img src="${pdfUrl}">`).join('<br>')
      } else {
        try {
          content = await fetchArticleWithCache(url, this, logger)
        } catch (error) {
          logger.error(
            `Failed to fetch article, using fallback: ${url}`,
            error as Error
          )
          content = `<p><strong>${category}</strong></p><p>${title}</p>`
        }
      }

      items.push({
        title,
        link: url,
        pubDate: date.toUTCString(),
        'content:encoded': content,
      })
    }
    return {
      status: true,
      items,
    }
  }

  async pdf2png(url: string): Promise<string[]> {
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`Failed to fetch pdf: ${res.status}`)
    }
    const pdfData = new Uint8Array(await res.arrayBuffer())
    const pdfDocument = await pdfjs.getDocument({ data: pdfData }).promise

    if (!fs.existsSync('output/tdr-updates/')) {
      fs.mkdirSync('output/tdr-updates/', { recursive: true })
    }
    const imageUrls = []
    for (let index = 1; index <= pdfDocument.numPages; index++) {
      const page = await pdfDocument.getPage(index)
      const viewport = page.getViewport({ scale: 1 })
      const canvas = createCanvas(viewport.width, viewport.height)
      const context = canvas.getContext('2d')

      await page.render({
        canvasContext: context as never,
        viewport,
        canvas,
      } as never).promise

      const image = canvas.toBuffer('image/png')
      const hash = this.hash(image)
      fs.writeFileSync(`output/tdr-updates/${hash}.png`, new Uint8Array(image))
      imageUrls.push(
        `https://book000.github.io/rss-deliver/tdr-updates/${hash}.png`
      )
    }
    return imageUrls
  }

  hash(buffer: Buffer): string {
    const hash = crypto.createHash('md5')
    hash.update(buffer)
    return hash.digest('hex')
  }
}
