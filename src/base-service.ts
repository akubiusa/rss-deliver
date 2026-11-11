import CollectResult, { Item } from './model/collect-result'
import ServiceInformation from './model/service-information'
import { getPreviousFeed, inheritPubDate } from './utils/previous-feed'
import { fetchDeletedArticlesHistory } from './utils/deleted-articles-tracker'
import { Logger } from '@book000/node-utils'

export abstract class BaseService {
  abstract information(): ServiceInformation

  abstract collect(): Promise<CollectResult>

  /**
   * Fills in the pubDate of items that have none.
   * The value is inherited from the previous feed, then restored from the deleted-articles history, and finally set to the current time.
   * @param items Items to process
   * @returns Items with pubDate set
   */
  async processPubDates(items: Item[]): Promise<Item[]> {
    const logger = Logger.configure(`${this.constructor.name}.processPubDates`)
    logger.info('🕒 Processing pubDates for items...')

    const countHasPubDate = items.filter((item) => item.pubDate).length

    const previousItems = await getPreviousFeed(this.constructor.name)

    const deletedHistory = await fetchDeletedArticlesHistory()

    const processedItems = items.map((item) =>
      inheritPubDate(item, previousItems, deletedHistory, this.constructor.name)
    )

    const countInheritedPubDate =
      processedItems.filter((item) => item.pubDate && item.pubDate !== '')
        .length - countHasPubDate

    const now = new Date()
    const processedItemsWithNow = processedItems.map((item) => {
      if (!item.pubDate) {
        logger.warn(`No pubDate found for item: ${item.title}. Setting to now.`)
        return {
          ...item,
          pubDate: now.toUTCString(),
        }
      }
      return item
    })

    const countWithNow = processedItemsWithNow.filter(
      (item) => item.pubDate === now.toUTCString()
    ).length

    logger.info(
      `Processed ${items.length} items: ${countHasPubDate} with pubDate, ${countInheritedPubDate} inherited pubDate, ${countWithNow} set to now`
    )

    return processedItemsWithNow
  }
}
