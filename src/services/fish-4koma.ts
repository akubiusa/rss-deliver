import { BaseService } from '@/base-service'
import { Logger } from '@book000/node-utils'
import CollectResult, { Item } from '@/model/collect-result'
import ServiceInformation from '@/model/service-information'
import * as cheerio from 'cheerio'
import fs from 'node:fs'
import crypto from 'node:crypto'
import sharp from 'sharp'
import { XMLParser } from 'fast-xml-parser'

export default class Fish4Koma extends BaseService {
  information(): ServiceInformation {
    return {
      title: '魚の4コマ',
      link: 'https://nyopenasu.livedoor.blog/',
      description: '魚の4コマ ニョペ茄子',
      image: {
        url: 'https://livedoor.blogimg.jp/nyopenasu/imgs/d/0/d01f1d67.jpg',
        title: '魚の4コマ',
        link: 'https://nyopenasu.livedoor.blog/',
      },
      generator: 'book000/rss-deliver',
      language: 'ja',
    }
  }

  async collect(): Promise<CollectResult> {
    const logger = Logger.configure('Fish4Koma::collect')

    const res = await fetch('https://nyopenasu.livedoor.blog/index.rdf')
    if (res.status !== 200) {
      logger.warn(`❗ Failed to fetch RSS feed (${res.status})`)
      return {
        status: false,
        items: [],
      }
    }

    const parser = new XMLParser({
      ignoreAttributes: false,
      parseAttributeValue: false,
    })
    const parsed = parser.parse(await res.text()) as {
      'rdf:RDF': {
        channel: unknown
        item?: {
          title: string
          link: string
          description: string
          'dc:date': string
        }[]
      }
    }
    const rssItems = parsed['rdf:RDF'].item

    if (!rssItems || rssItems.length === 0) {
      logger.warn('❗ No items found in RSS feed')
      return {
        status: false,
        items: [],
      }
    }

    const items: Item[] = []
    for (const rssItem of rssItems) {
      const itemUrl = rssItem.link
      logger.info(`📃 Processing: ${rssItem.title} - ${itemUrl}`)

      const itemRes = await fetch(itemUrl)
      if (itemRes.status !== 200) {
        logger.warn(`❗ Failed to fetch item page (${itemRes.status})`)
        continue
      }

      const $ = cheerio.load(await itemRes.text())

      const articleBody = $('.article-body-inner')
      const images: string[] = []

      articleBody.find('img').each((_, element) => {
        const src = $(element).attr('src')
        if (!src?.includes('livedoor.blogimg.jp')) {
          return
        }
        // Convert a thumbnail URL (-s suffix) to the original image URL
        const fullImageUrl = src.replace(/-s$/, '')
        images.push(fullImageUrl)
      })

      // Also take original images linked via <a>
      articleBody.find('a').each((_, element) => {
        const href = $(element).attr('href')
        if (
          href &&
          href.includes('livedoor.blogimg.jp') &&
          /\.(jpg|jpeg|png|gif)$/i.test(href) &&
          !images.includes(href)
        ) {
          images.push(href)
        }
      })

      if (images.length === 0) {
        logger.warn(`❗ No images found for: ${rssItem.title}`)
        continue
      }

      if (!fs.existsSync('output/fish4koma/')) {
        fs.mkdirSync('output/fish4koma/', { recursive: true })
      }

      let largestImageUrl: string | null = null
      let maxImageSize = 0

      // Find the largest image by pixel area
      for (const imageUrl of images) {
        try {
          const imageRes = await fetch(imageUrl)
          if (imageRes.status !== 200) {
            logger.warn(`❗ Failed to download image: ${imageUrl}`)
            continue
          }

          const buffer = Buffer.from(await imageRes.arrayBuffer())
          const metadata = await sharp(buffer).metadata()
          const imageSize = (metadata.width || 0) * (metadata.height || 0)

          if (imageSize > maxImageSize) {
            maxImageSize = imageSize
            largestImageUrl = imageUrl
          }
        } catch (error) {
          logger.warn(
            `❗ Error checking image size ${imageUrl}: ${String(error)}`
          )
        }
      }

      let savedImageUrl: string | null = null
      if (largestImageUrl) {
        try {
          const imageRes2 = await fetch(largestImageUrl)
          if (imageRes2.ok) {
            const buffer = Buffer.from(await imageRes2.arrayBuffer())

            // Trim the surrounding border, then add a 10px white margin
            const processedBuffer = await sharp(buffer)
              .trim()
              .extend({
                top: 10,
                bottom: 10,
                left: 10,
                right: 10,
                background: { r: 255, g: 255, b: 255, alpha: 1 },
              })
              .toBuffer()

            const hash = this.hash(processedBuffer)
            const outputPath = `output/fish4koma/${hash}.jpg`
            fs.writeFileSync(outputPath, processedBuffer)

            savedImageUrl = `https://book000.github.io/rss-deliver/fish4koma/${hash}.jpg`
          }
        } catch (error) {
          logger.warn(
            `❗ Error processing largest image ${largestImageUrl}: ${String(error)}`
          )
        }
      }

      if (savedImageUrl) {
        items.push({
          title: rssItem.title,
          link: itemUrl,
          description: rssItem.description,
          'content:encoded': `<img src="${savedImageUrl}">`,
          pubDate: rssItem['dc:date'],
        })
      }
    }

    return {
      status: true,
      items,
    }
  }

  hash(buffer: Buffer): string {
    const hash = crypto.createHash('md5')
    hash.update(buffer)
    return hash.digest('hex')
  }
}
