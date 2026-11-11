import { BaseService } from '@/base-service'
import { Logger } from '@book000/node-utils'
import CollectResult, { Item } from '@/model/collect-result'
import ServiceInformation from '@/model/service-information'
import * as cheerio from 'cheerio'
import { XMLParser } from 'fast-xml-parser'
import fs from 'node:fs'
import crypto from 'node:crypto'
import sharp, { type OverlayOptions } from 'sharp'

/**
 * Page data of the contentsInfo API
 */
interface PageContentInfo {
  /** Image URL (signed) */
  imageUrl: string
  /** Scramble array (JSON string) */
  scramble: string
  /** Sort order */
  sort: number
  /** Image width */
  width: number
  /** Image height */
  height: number
  /** Expiration */
  expiresOn: number
}

/**
 * Response of the contentsInfo API
 */
interface ContentsInfoResponse {
  /** Total number of pages */
  totalPages: number
  /** Scroll direction */
  scrollDirection: string
  /** Spread specification */
  spreadDesignation: number
  /** Page data (an array in page order) */
  result: PageContentInfo[]
}

/**
 * Thumbnail element of the official RSS of Takecomic (竹コミ！)
 */
interface TakecomicRssMediaThumbnail {
  /** Thumbnail image URL */
  '@_url'?: string
}

/**
 * item element of the official RSS of Takecomic
 */
interface TakecomicRssItem {
  /** Episode title */
  title?: string
  /** Episode URL */
  link?: string
  /** Publication time */
  pubDate?: string
  /** Thumbnail */
  'media:thumbnail'?: TakecomicRssMediaThumbnail
}

/**
 * channel element of the official RSS of Takecomic
 */
interface TakecomicRssChannel {
  /** Episodes */
  item?: TakecomicRssItem | TakecomicRssItem[]
}

/**
 * Parsed official RSS of Takecomic
 */
interface TakecomicRssResponse {
  /** RSS root */
  rss?: {
    /** Channel */
    channel?: TakecomicRssChannel
  }
}

/**
 * An episode of Pop Team Epic
 */
interface TakecomicEpisode {
  /** Title */
  title: string
  /** Episode URL */
  url: string
  /** Publication date (YYYY/MM/DD, JST) */
  date: string
  /** Thumbnail image URL */
  thumbnailUrl: string
}

/**
 * Pop Team Epic (ポプテピピック) service.
 *
 * Collects the latest episodes from Takecomic (竹コミ！) and delivers each episode as an item whose content is the page images.
 */
export default class PopTeamEpic extends BaseService {
  private title: string | null = null
  private link: string | null = null
  private image: string | null = null
  private siteName: string | null = null

  private static readonly COMMON_HEADERS = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
  }

  information(): ServiceInformation {
    if (!this.title || !this.link || !this.image || !this.siteName) {
      throw new Error('Service is not initialized')
    }
    return {
      title: this.title,
      link: this.link,
      description: `${this.title} / 大川ぶくぶ / ${this.siteName}`,

      image: {
        url: this.image,
        title: this.title,
        link: this.link,
      },
      generator: 'book000/rss-deliver',
      language: 'ja',
    }
  }

  async collect(): Promise<CollectResult> {
    const logger = Logger.configure('PopTeamEpic::collect')

    const activeSeason = await this.fetchActiveSeason()
    if (!activeSeason) {
      logger.warn('❗ No active season found')
      return {
        status: false,
        items: [],
      }
    }

    logger.info(`👀 ${activeSeason.title} ${activeSeason.url}`)

    this.title = activeSeason.title
    this.link = activeSeason.url
    this.image = activeSeason.image
    this.siteName = activeSeason.siteName

    const items = await this.collectTakecomicItems(activeSeason.url)

    return {
      status: true,
      items,
    }
  }

  async fetchActiveSeason(): Promise<{
    title: string
    url: string
    image: string
    siteName: string
    source: 'takecomic'
  } | null> {
    return this.fetchTakecomicSeason()
  }

  private async fetchTakecomicSeason(): Promise<{
    title: string
    url: string
    image: string
    siteName: string
    source: 'takecomic'
  } | null> {
    const logger = Logger.configure('PopTeamEpic::fetchTakecomicSeason')
    const takecomicSeriesUrl = 'https://takecomic.jp/series/8f3616ce97c36'
    const res = await fetch(takecomicSeriesUrl, {
      headers: {
        ...PopTeamEpic.COMMON_HEADERS,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    if (res.status !== 200) {
      logger.warn(
        `❗ Failed to fetch takecomic series page (status=${res.status})`
      )
      return null
    }

    const $ = cheerio.load(await res.text())
    const title = $('meta[property="og:title"]').attr('content')?.trim() ?? ''
    const image = PopTeamEpic.normalizeUrl(
      $('meta[property="og:image"]').attr('content') ?? ''
    )
    return title && image
      ? {
          title,
          url: takecomicSeriesUrl,
          image,
          siteName: '竹コミ！',
          source: 'takecomic',
        }
      : null
  }

  /**
   * Collects the episodes and builds the RSS items.
   *
   * @param seriesUrl URL of the series page
   * @returns RSS items
   */
  private async collectTakecomicItems(seriesUrl: string): Promise<Item[]> {
    const logger = Logger.configure('PopTeamEpic::collectTakecomicItems')
    const items: Item[] = []
    const episodes = await this.fetchTakecomicEpisodesFromRss(seriesUrl, logger)

    for (const episode of episodes) {
      const date = this.parseJstDate(episode.date)

      const imageUrls = await this.fetchEpisodeImages(episode.url, logger)

      // Fall back to the thumbnail if no page image could be obtained
      if (imageUrls.length === 0 && episode.thumbnailUrl) {
        logger.warn(`⚠️ Falling back to thumbnail for ${episode.title}`)
        const thumbnailUrls = await this.saveImages(
          [episode.thumbnailUrl],
          logger
        )
        if (thumbnailUrls.length > 0) {
          imageUrls.push(...thumbnailUrls)
        }
      }

      if (imageUrls.length === 0) {
        logger.warn(`❗ No images for ${episode.title}`)
        continue
      }

      const itemTitle = episode.date
        ? `${episode.date} ${episode.title}`
        : episode.title
      logger.info(`📃 ${itemTitle} ${episode.url} (${imageUrls.length} images)`)
      items.push({
        title: itemTitle,
        link: episode.url,
        'content:encoded': imageUrls
          .map((url) => `<img src="${url}">`)
          .join('<br>'),
        ...(date && { pubDate: date.toUTCString() }),
      })
    }
    return items
  }

  /**
   * Fetches the latest 10 episodes from the official RSS (`<series URL>/rss`).
   *
   * @param seriesUrl URL of the series page
   * @param logger Logger
   * @returns Episodes (empty array on failure)
   */
  private async fetchTakecomicEpisodesFromRss(
    seriesUrl: string,
    logger: Logger
  ): Promise<TakecomicEpisode[]> {
    const rssUrl = `${seriesUrl.replace(/\/$/, '')}/rss`
    const res = await fetch(rssUrl)
    if (res.status !== 200) {
      logger.warn(`❗ Failed to fetch official RSS (${res.status}) ${rssUrl}`)
      return []
    }

    let rawItems: TakecomicRssItem | TakecomicRssItem[] | undefined
    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
      })
      const rss = parser.parse(await res.text()) as TakecomicRssResponse
      rawItems = rss.rss?.channel?.item
    } catch (error) {
      logger.warn(`❗ Failed to parse official RSS: ${String(error)}`)
      return []
    }
    if (!rawItems) {
      logger.warn('❗ No item entries in official RSS')
      return []
    }

    const items = Array.isArray(rawItems) ? rawItems : [rawItems]
    const episodes: TakecomicEpisode[] = []
    const seen = new Set<string>()

    for (const item of items) {
      const title = item.title?.trim() ?? ''
      const url = this.normalizeEpisodeUrl(item.link ?? '')
      if (!title || !url || seen.has(url)) {
        continue
      }
      seen.add(url)

      const date = this.formatRssPubDateToJstDate(item.pubDate ?? '')
      const thumbnailUrl = PopTeamEpic.normalizeUrl(
        item['media:thumbnail']?.['@_url'] ?? ''
      )

      episodes.push({
        title,
        url,
        date,
        thumbnailUrl,
      })
    }

    return episodes.slice(0, 10)
  }

  /**
   * Fetches all page images of an episode.
   *
   * @param episodeUrl URL of the episode page
   * @param logger Logger
   * @returns URLs of the saved images (empty array on failure)
   */
  private async fetchEpisodeImages(
    episodeUrl: string,
    logger: Logger
  ): Promise<string[]> {
    try {
      const res = await fetch(episodeUrl, {
        headers: {
          ...PopTeamEpic.COMMON_HEADERS,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      })
      if (res.status !== 200) {
        logger.warn(`❗ Failed to fetch episode page (${res.status})`)
        return []
      }

      const viewerId = this.extractViewerId(await res.text())
      if (!viewerId) {
        logger.warn('❗ viewerId not found in episode page')
        return []
      }

      const contentsInfo = await this.fetchContentsInfo(viewerId, episodeUrl)
      if (!contentsInfo || contentsInfo.totalPages === 0) {
        logger.warn('❗ No pages found in contentsInfo')
        return []
      }

      logger.info(`📖 Found ${contentsInfo.totalPages} pages`)

      const imageUrls: string[] = []
      for (let i = 0; i < contentsInfo.totalPages; i++) {
        const pageData = contentsInfo.result[i] as PageContentInfo | undefined
        if (!pageData) {
          continue
        }

        const imageUrl = await this.fetchAndUnscrambleImage(
          pageData,
          episodeUrl,
          logger
        )
        if (imageUrl) {
          imageUrls.push(imageUrl)
        }
      }

      return imageUrls
    } catch (error) {
      logger.warn(`❗ Failed to fetch episode images: ${String(error)}`)
      return []
    }
  }

  /**
   * Extracts the viewerId from HTML.
   *
   * @param html HTML string
   * @returns The viewerId, or null if not found
   */
  private extractViewerId(html: string): string | null {
    // Look for the viewerId in the data-comici-viewer-id attribute
    const dataAttrRegex = /data-comici-viewer-id="([a-f0-9]{32})"/i
    const dataAttrMatch = dataAttrRegex.exec(html)
    if (dataAttrMatch?.[1]) {
      return dataAttrMatch[1]
    }

    // Fallback: look for it in __next_f (React Server Components)
    const jsonRegex = /"viewerId":"([a-f0-9]{32})"/i
    const jsonMatch = jsonRegex.exec(html)
    return jsonMatch?.[1] ?? null
  }

  /**
   * Calls the contentsInfo API.
   *
   * The API returns a 400 error if page-to exceeds the actual number of pages,
   * so first fetch totalPages with page-to=1, then fetch all pages.
   *
   * @param viewerId Viewer ID
   * @param episodeUrl Episode URL (used for the Referer header)
   * @returns API response, or null on an HTTP error
   */
  private async fetchContentsInfo(
    viewerId: string,
    episodeUrl: string
  ): Promise<ContentsInfoResponse | null> {
    const logger = Logger.configure('PopTeamEpic::fetchContentsInfo')

    const headers = {
      Origin: 'https://takecomic.jp',
      Referer: episodeUrl,
      ...PopTeamEpic.COMMON_HEADERS,
      Accept: 'application/json, text/plain, */*',
    }

    // Step 1: get totalPages with page-to=1
    const initialParams = new URLSearchParams({
      'user-id': '',
      'comici-viewer-id': viewerId,
      'page-from': '0',
      'page-to': '1',
    })
    const initialUrl = `https://takecomic.jp/api/book/contentsInfo?${initialParams.toString()}`

    logger.info(`📡 Fetching totalPages: viewerId=${viewerId}`)

    const initialRes = await fetch(initialUrl, { headers })

    if (initialRes.status !== 200) {
      logger.warn(
        `❌ API error (initial): status=${initialRes.status}, viewerId=${viewerId}`
      )
      return null
    }

    const initialData = (await initialRes.json()) as ContentsInfoResponse
    const totalPages = initialData.totalPages
    logger.info(`📖 totalPages=${totalPages}`)

    if (totalPages <= 1) {
      // With a single page, the first response is already complete
      return initialData
    }

    // Step 2: fetch all pages
    const fullParams = new URLSearchParams({
      'user-id': '',
      'comici-viewer-id': viewerId,
      'page-from': '0',
      'page-to': String(totalPages),
    })
    const fullUrl = `https://takecomic.jp/api/book/contentsInfo?${fullParams.toString()}`

    const fullRes = await fetch(fullUrl, { headers })

    if (fullRes.status !== 200) {
      logger.warn(
        `❌ API error (full): status=${fullRes.status}, viewerId=${viewerId}`
      )
      return null
    }

    logger.info(`✅ Fetched ${totalPages} pages successfully`)

    return (await fullRes.json()) as ContentsInfoResponse
  }

  /**
   * Downloads a scrambled image, restores it and saves it.
   *
   * @param pageData Page data
   * @param episodeUrl Episode URL (used for the Referer header)
   * @param logger Logger
   * @returns URL of the saved image, or null on failure
   */
  private async fetchAndUnscrambleImage(
    pageData: PageContentInfo,
    episodeUrl: string,
    logger: Logger
  ): Promise<string | null> {
    try {
      // The CloudFront signed URL requires appropriate headers
      const res = await fetch(pageData.imageUrl, {
        headers: {
          Referer: episodeUrl,
          ...PopTeamEpic.COMMON_HEADERS,
          Accept:
            'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      })

      if (res.status !== 200) {
        logger.warn(`❗ Failed to download image (${res.status})`)
        return null
      }

      const scrambledBuffer = Buffer.from(await res.arrayBuffer())

      let scramble: number[]
      try {
        scramble = JSON.parse(pageData.scramble)
      } catch {
        logger.warn('❗ Invalid scramble JSON, using original image')
        return await this.saveUnscrambledImage(scrambledBuffer)
      }

      const unscrambledBuffer = await this.unscrambleImage(
        scrambledBuffer,
        scramble
      )

      return await this.saveUnscrambledImage(unscrambledBuffer)
    } catch (error) {
      logger.warn(`❗ Failed to unscramble image: ${String(error)}`)
      return null
    }
  }

  /**
   * Restores a scrambled image.
   *
   * @param buffer Scrambled image buffer
   * @param scramble Scramble array
   * @returns Restored image buffer (the input if it cannot be restored)
   */
  private async unscrambleImage(
    buffer: Buffer,
    scramble: number[]
  ): Promise<Buffer> {
    // Grid size (normally 4x4 = 16 tiles)
    const gridSize = Math.sqrt(scramble.length)
    if (!Number.isSafeInteger(gridSize)) {
      // Not a square grid: treat as not scrambled
      return buffer
    }

    const image = sharp(buffer)
    const metadata = await image.metadata()

    if (!metadata.width || !metadata.height) {
      return buffer
    }

    const actualTileWidth = Math.floor(metadata.width / gridSize)
    const actualTileHeight = Math.floor(metadata.height / gridSize)

    // Extract the tiles (clone() avoids decoding again)
    // In column-major order: (0,0), (0,1), (0,2), (0,3), (1,0)...
    const tiles: Buffer[] = []
    for (let c = 0; c < gridSize; c++) {
      for (let r = 0; r < gridSize; r++) {
        const left = c * actualTileWidth
        const top = r * actualTileHeight

        const tile = await image
          .clone()
          .extract({
            left,
            top,
            width: actualTileWidth,
            height: actualTileHeight,
          })
          .toBuffer()

        tiles.push(tile)
      }
    }

    // Rearrange the tiles according to the scramble array: scramble[i] = srcIndex
    // The output is also placed in column-major order
    const compositeOperations: OverlayOptions[] = []
    let destTileIndex = 0
    for (let c = 0; c < gridSize; c++) {
      for (let r = 0; r < gridSize; r++) {
        const srcIndex = scramble[destTileIndex]

        if (srcIndex < 0 || srcIndex >= tiles.length) {
          return buffer
        }

        compositeOperations.push({
          input: tiles[srcIndex],
          left: c * actualTileWidth,
          top: r * actualTileHeight,
        })
        destTileIndex++
      }
    }

    const unscrambled = await sharp({
      create: {
        width: actualTileWidth * gridSize,
        height: actualTileHeight * gridSize,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite(compositeOperations)
      .jpeg({ quality: 90 })
      .toBuffer()

    return unscrambled
  }

  /**
   * Saves a restored image to `output/popute/` after trimming it and adding a 10px white margin.
   *
   * @param buffer Image buffer
   * @returns URL of the saved image
   */
  private async saveUnscrambledImage(buffer: Buffer): Promise<string> {
    if (!fs.existsSync('output/popute/')) {
      fs.mkdirSync('output/popute/', { recursive: true })
    }

    const processedBuffer = await sharp(buffer)
      .trim()
      .extend({
        top: 10,
        bottom: 10,
        left: 10,
        right: 10,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .jpeg({ quality: 90 })
      .toBuffer()

    const hash = this.hash(processedBuffer)
    fs.writeFileSync(`output/popute/${hash}.jpg`, processedBuffer)
    return `https://book000.github.io/rss-deliver/popute/${hash}.jpg`
  }

  /**
   * Converts the pubDate of the official RSS to a JST date string.
   *
   * @param pubDate pubDate of the official RSS
   * @returns Date string in YYYY/MM/DD format (empty string if unparsable)
   */
  private formatRssPubDateToJstDate(pubDate: string): string {
    const parsedDate = new Date(pubDate)
    if (Number.isNaN(parsedDate.getTime())) {
      return ''
    }

    const jstDate = new Date(parsedDate.getTime() + 9 * 60 * 60 * 1000)
    const year = jstDate.getUTCFullYear()
    const month = String(jstDate.getUTCMonth() + 1).padStart(2, '0')
    const day = String(jstDate.getUTCDate()).padStart(2, '0')
    return `${year}/${month}/${day}`
  }

  /**
   * Normalizes a URL in the official RSS to an episode URL.
   *
   * @param url URL in the official RSS
   * @returns Episode URL without query, hash and trailing slash
   */
  private normalizeEpisodeUrl(url: string): string {
    const normalizedUrl = PopTeamEpic.normalizeUrl(url)
    if (!normalizedUrl) {
      return ''
    }

    try {
      const parsedUrl = new URL(normalizedUrl)
      parsedUrl.search = ''
      parsedUrl.hash = ''
      return parsedUrl.href.replace(/\/$/, '')
    } catch {
      return normalizedUrl
    }
  }

  private async saveImages(
    images: string[],
    logger: Logger
  ): Promise<string[]> {
    if (!fs.existsSync('output/popute/')) {
      fs.mkdirSync('output/popute/', { recursive: true })
    }

    const imageUrls: string[] = []
    for (const image of images) {
      const buffer = await this.fetchImageBuffer(image, logger)
      if (!buffer) {
        continue
      }

      const trimmedBuffer = await sharp(buffer)
        .trim()
        .extend({
          top: 10,
          bottom: 10,
          left: 10,
          right: 10,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        })
        .jpeg({ quality: 90 })
        .toBuffer()

      const hash = this.hash(trimmedBuffer)
      fs.writeFileSync(`output/popute/${hash}.jpg`, trimmedBuffer)
      imageUrls.push(`https://book000.github.io/rss-deliver/popute/${hash}.jpg`)
    }
    return imageUrls
  }

  private async fetchImageBuffer(
    image: string,
    logger: Logger
  ): Promise<Buffer | null> {
    if (image.startsWith('data:image/')) {
      const base64 = image.replace(/^data:image\/\w+;base64,/, '')
      return Buffer.from(base64, 'base64')
    }

    const imageUrl = PopTeamEpic.normalizeUrl(image)
    const imageRes = await fetch(imageUrl)
    if (imageRes.status !== 200) {
      logger.warn(
        `❗ Failed to download image (${imageRes.status}) ${imageUrl}`
      )
      return null
    }
    return Buffer.from(await imageRes.arrayBuffer())
  }

  private parseJstDate(dateText: string): Date | null {
    if (!dateText) {
      return null
    }
    const [year, month, day] = dateText.split('/', 3)
    return year && month && day
      ? new Date(`${year}-${month}-${day}T00:00:00+09:00`)
      : null
  }

  private static normalizeUrl(url: string): string {
    if (url.startsWith('//')) {
      return `https:${url}`
    }
    return url.startsWith('/') ? new URL(url, 'https://takecomic.jp').href : url
  }

  hash(buffer: Buffer): string {
    const hash = crypto.createHash('md5')
    hash.update(buffer)
    return hash.digest('hex')
  }
}
