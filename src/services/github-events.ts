import { BaseService } from '@/base-service'
import { Logger } from '@book000/node-utils'
import CollectResult, { Item } from '@/model/collect-result'
import ServiceInformation from '@/model/service-information'
import * as cheerio from 'cheerio'
import ical, { VEvent, ParameterValue } from 'node-ical'

/** URL of the public Google Calendar ICS file */
const ICS_URL =
  'https://calendar.google.com/calendar/ical/c_3d2f8eb9fd2c835a0d1c214386c9312d681ae2ddf456d2843bd7f0a73c770767%40group.calendar.google.com/public/basic.ics'

/** URL of the GitHub events page */
const EVENTS_PAGE_URL = 'https://resources.github.com/ja/events/'

/**
 * Gets the string value of a ParameterValue.
 * @param value A string or an object with parameters
 * @returns The string value, or undefined if there is none
 */
function getParameterValue(
  value: ParameterValue | undefined
): string | undefined {
  return typeof value === 'string' ? value : value?.val
}

/**
 * Extracts the event URL from the ICS DESCRIPTION (HTML).
 * @param description Description in HTML
 * @returns The first http(s) link, or undefined if none is found
 */
function extractEventUrl(description: string): string | undefined {
  const $ = cheerio.load(description)
  const links = $('a[href]')
  for (const element of links) {
    const href = $(element).attr('href')
    if (href?.startsWith('http')) {
      return href
    }
  }
  return undefined
}

/**
 * Delivers GitHub events (webinars, etc.) from a Google Calendar ICS file as RSS.
 */
export default class GitHubEvents extends BaseService {
  /**
   * Returns the feed metadata.
   * @returns Feed metadata
   */
  information(): ServiceInformation {
    return {
      title: 'GitHub イベント',
      link: EVENTS_PAGE_URL,
      description:
        'GitHub またはパートナーが主催・共催・協賛するイベント、およびコミュニティー主催の GitHub に関連するイベントの情報',
      generator: 'book000/rss-deliver',
      language: 'ja',
    }
  }

  /**
   * Collects RSS items from the ICS file.
   * @returns Collected items and status
   */
  async collect(): Promise<CollectResult> {
    const logger = Logger.configure('GitHubEvents.collect')

    try {
      const res = await fetch(ICS_URL)
      if (res.status !== 200) {
        logger.error(`❌ Failed to fetch ICS: ${res.status}`)
        return {
          status: false,
          items: [],
        }
      }

      const calendar = ical.sync.parseICS(await res.text())

      const events = Object.values(calendar).filter(
        (component): component is VEvent => component?.type === 'VEVENT'
      )

      logger.info(`📅 Found ${events.length} events`)

      const sortedEvents = events.toSorted((a, b) => {
        const aTime = a.start instanceof Date ? a.start.getTime() : 0
        const bTime = b.start instanceof Date ? b.start.getTime() : 0
        return bTime - aTime
      })

      const items: Item[] = []
      for (const event of sortedEvents) {
        const title = getParameterValue(event.summary) ?? '(タイトルなし)'
        const descriptionRaw = getParameterValue(event.description)

        const eventUrl =
          event.url ??
          (descriptionRaw ? extractEventUrl(descriptionRaw) : undefined) ??
          EVENTS_PAGE_URL

        // pubDate is the event start time
        const pubDate =
          event.start instanceof Date ? event.start.toUTCString() : undefined

        const contentParts: string[] = []

        if (event.start instanceof Date) {
          const startStr = event.start.toLocaleString('ja-JP', {
            timeZone: 'Asia/Tokyo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })
          contentParts.push(`<p>開始: ${startStr}</p>`)
        }
        if (event.end instanceof Date) {
          const endStr = event.end.toLocaleString('ja-JP', {
            timeZone: 'Asia/Tokyo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })
          contentParts.push(`<p>終了: ${endStr}</p>`)
        }

        const location = getParameterValue(event.location)
        if (location) {
          contentParts.push(`<p>場所: ${location}</p>`)
        }

        if (descriptionRaw) {
          contentParts.push(`<hr />${descriptionRaw}`)
        }

        contentParts.push(
          `<p><a href="${EVENTS_PAGE_URL}">GitHub イベント一覧ページ</a></p>`
        )

        logger.info(`📌 ${title} [${pubDate ?? 'no date'}]`)

        items.push({
          title,
          link: eventUrl,
          'content:encoded': contentParts.join('\n'),
          pubDate,
          guid: {
            '@_isPermaLink': false,
            '#text': event.uid,
          },
        })
      }

      return {
        status: true,
        items,
      }
    } catch (error) {
      logger.error('❌ Failed to collect GitHub events', error as Error)
      return {
        status: false,
        items: [],
      }
    }
  }
}
