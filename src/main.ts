import XMLBuilder from 'fast-xml-builder'
import { XMLParser } from 'fast-xml-parser'
import fs from 'node:fs'
import { BaseService } from './base-service'
import { Logger } from '@book000/node-utils'
import FF14LodestoneMaintenance from './services/ff14-lodestone-maintenance'
import FF14LodestoneNews from './services/ff14-lodestone-news'
import FF14LodestoneObstacle from './services/ff14-lodestone-obstacle'
import FF14LodestoneUpdate from './services/ff14-lodestone-update'
import PhysicalUpLettuceClub from './services/physical-up-lettuce-club'
import Rikei2LettuceClub from './services/rikei-2-lettuce-club'
import ZennChangelog from './services/zenn-changelog'
import Dev1and from './services/dev1and'
import TdrUpdates from './services/tdr-updates'
import PopTeamEpic from './services/pop-team-epic'
import Fish4Koma from './services/fish-4koma'
import GitHubEvents from './services/github-events'
import DisneyParksNewShows from './services/disney-parks-new-shows'
import {
  fetchDeletedArticlesHistory,
  detectDeletedArticles,
  updateDeletedArticlesHistory,
  saveDeletedArticlesHistory,
} from './utils/deleted-articles-tracker'
import { DeletedArticle } from './model/deleted-article'
import { carryOverPreviousFeed, getPreviousFeed } from './utils/previous-feed'
import { Item } from './model/collect-result'

/**
 * Generates and writes the RSS file of a service.
 *
 * collect() runs only once here; the collected items are returned so that deleted-article detection can reuse them.
 *
 * @param service Target service
 * @returns Collected items before pubDate processing, or undefined if the service failed (its previous feed is carried over when one is available)
 */
async function generateRSSService(
  service: BaseService
): Promise<Item[] | undefined> {
  const filename = service.constructor.name
  const logger = Logger.configure(`main.generateRSSService#${filename}`)
  logger.info(`📝 Generating ${filename}...`)
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
  })

  try {
    const collect = await service.collect()
    if (collect.status) {
      const processedItems = await service.processPubDates(collect.items)

      const object = {
        '?xml': {
          '@_version': '1.0',
          // eslint-disable-next-line unicorn/text-encoding-identifier-case
          '@_encoding': 'UTF-8',
        },
        rss: {
          '@_version': '2.0',
          '@_xmlns:dc': 'https://purl.org/dc/elements/1.1/',
          '@_xmlns:content': 'https://purl.org/rss/1.0/modules/content/',
          '@_xmlns:atom': 'https://www.w3.org/2005/Atom',
          channel: {
            ...service.information(),
            item: processedItems,
          },
        },
      }

      const feed: {
        toString: () => string
      } = builder.build(object)

      fs.writeFileSync('output/' + filename + '.xml', feed.toString())
      logger.info(`✅ Generated ${filename}`)

      return collect.items
    }
    logger.warn(`❌ ${filename} is not available`)
  } catch (error) {
    logger.error(
      `❌ Error occurred while generating ${filename}`,
      error as Error
    )
  }

  await carryOverPreviousFeed(filename)
  return undefined
}

async function generateRSS() {
  const logger = Logger.configure('main.generateRSS')
  logger.info('✨ Generating RSS...')

  let deletedHistory = await fetchDeletedArticlesHistory()

  const services: BaseService[] = [
    new ZennChangelog(),
    new FF14LodestoneNews(),
    new FF14LodestoneMaintenance(),
    new FF14LodestoneUpdate(),
    new FF14LodestoneObstacle(),
    new PhysicalUpLettuceClub(),
    new Rikei2LettuceClub(),
    new Dev1and(),
    new TdrUpdates(),
    new PopTeamEpic(),
    new Fish4Koma(),
    new GitHubEvents(),
    new DisneyParksNewShows(),
  ]

  const allDeletedArticles: DeletedArticle[] = []

  const promises: Promise<void>[] = services.map(async (service) => {
    try {
      const serviceName = service.constructor.name

      const previousItems = await getPreviousFeed(serviceName)

      const collectedItems = await generateRSSService(service)

      if (collectedItems) {
        if (previousItems.length > 0) {
          const deletedArticles = detectDeletedArticles(
            previousItems,
            collectedItems,
            serviceName
          )
          if (deletedArticles.length > 0) {
            logger.info(
              `🗑️ [${serviceName}] Detected ${deletedArticles.length} deleted articles`
            )
            allDeletedArticles.push(...deletedArticles)
          } else {
            logger.info(`📋 [${serviceName}] No deleted articles detected`)
          }
        } else {
          logger.info(
            `📄 [${serviceName}] No previous feed found, skipping deletion detection`
          )
        }
      }
    } catch (error) {
      logger.error(
        `❌ Error occurred while generating RSS: ${service.constructor.name}`,
        error as Error
      )
    }
  })

  await Promise.all(promises)

  logger.info(
    `📊 Total deleted articles detected: ${allDeletedArticles.length}`
  )

  // output/ is deployed wholesale, so the history must be written on every run to survive the next deploy
  deletedHistory = updateDeletedArticlesHistory(
    deletedHistory,
    allDeletedArticles
  )
  saveDeletedArticlesHistory(deletedHistory)
}

function generateList() {
  const logger = Logger.configure('main.generateList')
  logger.info('✨ Generating list...')
  const files = fs.readdirSync('output')
  const template = fs.readFileSync('template.html', 'utf8')
  const list = files
    .map((file) => {
      if (!file.endsWith('.xml')) {
        return null
      }
      const parser = new XMLParser({
        ignoreAttributes: false,
      })

      const feed: {
        rss: {
          channel: {
            title: string
          }
        }
      } = parser.parse(fs.readFileSync('output/' + file, 'utf8'))
      const title = feed.rss.channel.title
      return "<li><a href='" + file + "'>" + title + '</a></li>'
    })
    .filter((s) => s !== null)
  fs.writeFileSync(
    'output/index.html',
    template.replace(
      '{{ RSS-FILES }}',
      () => '<ul>' + list.join('\n') + '</ul>'
    )
  )
  logger.info('✅ Generated list')
}

async function main() {
  if (!fs.existsSync('output')) {
    fs.mkdirSync('output')
  }

  await generateRSS()
  generateList()
}

;(async () => {
  await main()
})()
