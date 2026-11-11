import { Item } from '@/model/collect-result'
import { parsePreviousFeed } from '@/utils/previous-feed'
import DisneyParksNewShows, {
  Candidate,
  mergeItems,
  parseOlcHtml,
  parseWordPressFeed,
  resolveDpbRegion,
  SourceFetcher,
} from '@/services/disney-parks-new-shows'
import { detectDeletedArticles } from '@/utils/deleted-articles-tracker'
import { classifyShow } from '@/utils/show-classifier'
import XMLBuilder from 'fast-xml-builder'
import fs from 'node:fs'

const NOW = new Date('2026-10-27T00:00:00Z')
const DAY_MS = 86_400_000
const BASE_URL = 'https://example.com/'

let failures = 0
let total = 0

/**
 * Compares the actual value with the expected one and prints the result.
 * @param name Case name
 * @param actual Actual value
 * @param expected Expected value
 */
function check(name: string, actual: unknown, expected: unknown): void {
  total++
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`ok   ${name}`)
    return
  }
  failures++
  console.log(
    `FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
}

/**
 * Returns the time the given number of milliseconds before NOW.
 * @param ms Elapsed milliseconds
 * @returns Time
 */
function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms)
}

/**
 * Creates an item for verification.
 * @param path The part of the link after BASE_URL
 * @param publishedAt Publication time
 * @param title Title (path if omitted)
 * @returns Item
 */
function makeItem(path: string, publishedAt: Date, title = path): Item {
  const link = `${BASE_URL}${path}`
  return {
    title,
    link,
    guid: { '#text': link },
    pubDate: publishedAt.toUTCString(),
  }
}

/**
 * Creates a candidate for verification.
 * @param path The part of the link after BASE_URL
 * @param title Title
 * @param publishedAt Publication time
 * @param region Region name
 * @returns Candidate
 */
function makeCandidate(
  path: string,
  title: string,
  publishedAt: Date | undefined,
  region = 'A'
): Candidate {
  return {
    region,
    title,
    link: `${BASE_URL}${path}`,
    pubDate: publishedAt,
    summary: 's',
    bodyText: '',
  }
}

/**
 * Creates a source for verification. Passing an Error makes the fetch fail.
 * @param name Name of the source
 * @param result Candidates to return, or the exception to throw
 * @returns Source
 */
function makeSource(name: string, result: Candidate[] | Error): SourceFetcher {
  return {
    name,
    fetch: () =>
      result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result),
  }
}

/**
 * Creates a successful source that only returns one article that the classifier rejects.
 * @param name Name of the source
 * @returns Source
 */
function makeFillerSource(name: string): SourceFetcher {
  return makeSource(name, [
    makeCandidate(`${name}-filler`, 'Merchandise Guide', ago(DAY_MS), name),
  ])
}

/**
 * Comparison function that sorts strings in dictionary order.
 * @param a String
 * @param b String
 * @returns Comparison result
 */
function compareText(a: string, b: string): number {
  return a.localeCompare(b)
}

/**
 * Returns the links of the items.
 * @param items Items
 * @returns Links
 */
function links(items: Item[]): string[] {
  return items.map((item) => item.link)
}

/**
 * Verifies pairs of classifyShow input and expected result.
 */
function verifyClassifier(): void {
  const longFiller = 'park news and updates for guests. '.repeat(40)

  const accepted: [string, string, string, string][] = [
    ['A1', '新規ショー『ブリング・ザ・リズム！』', '', ''],
    ['A2', 'Introducing a New Parade at Disneyland Paris', '', ''],
    ['A3', 'Nouveau défilé de Noël', '', ''],
    ['A4', 'NOUVEAU DEFILE DE NOEL', '', ''],
    [
      'A5',
      'Pixar Summer Fest',
      '',
      'Guests can see the all-new Pixar parade debut this summer.',
    ],
    ['A6', 'The show reopens with a new parade', '', ''],
    ['A7', '新しい夜のキャッスルプロジェクションがスタート', '', ''],
    [
      'A8',
      '東京ディズニーシー「ハンガーステージ」で新エンターテイメントプログラムを開催',
      '',
      '',
    ],
    [
      'A9',
      '東京ディズニーシー新規ナイトタイムエンターテイメントがスタート',
      '',
      '',
    ],
    [
      'A10',
      'Hong Kong Disneyland presents the first-ever in-park live orchestra performance',
      '',
      '',
    ],
    [
      'A11',
      'Une toute nouvelle parade de jour au Parc Disneyland en 2028',
      '',
      '',
    ],
    [
      'A15',
      'Disney Starlight Nighttime Parade Coming to Magic Kingdom “Later This Summer”',
      '',
      '',
    ],
    [
      'A16',
      'Disneyland Paris to Unveil a New Spectacular Projected onto Sleeping Beauty Castle',
      '',
      '',
    ],
    [
      'A17',
      'All-New Nighttime Parade Coming to Magic Kingdom in Summer 2025',
      '',
      '',
    ],
    [
      'A18',
      'Two New Nighttime Spectaculars Coming to Disneyland Resort in 2023',
      '',
      '',
    ],
    [
      'A19',
      'BREAKING: Brand New Nighttime Spectacular to Replace “Wishes” Beginning May 12',
      '',
      '',
    ],
    [
      'A12',
      'Hong Kong Disneyland Resort to proudly present Much-anticipated Nighttime Spectacular “Momentous” in mid-June',
      '',
      '',
    ],
    [
      'A13',
      'Summer at the resort',
      '',
      `Guests will love the brand-new nighttime spectacular. ${longFiller}`,
    ],
    [
      'A14',
      'Resort update',
      '',
      `${longFiller}The new parade opens soon. ${longFiller}A second new show follows.`,
    ],
    ['A20', '新規ショー『ブリング・ザ・リズム！』'.normalize('NFD'), '', ''],
    ['A21', 'Nouveau défilé de Noël'.normalize('NFD'), '', ''],
    ['A22', '最新情報', '', 'ショーが 7 月に初披露されます。'],
    ['A23', 'Park news', '', 'The fireworks spectacular debuts on July 4.'],
    ['A24', 'Actualités du parc', '', 'Un défilé nouveau arrive cet été.'],
    ['A25', 'Actualités du parc', '', 'Les nouveaux feux d’artifice du parc.'],
    ['A26', 'All-New Show™ Coming to Disneyland', '', ''],
    ['A27', 'New™ Parade℠ Debuts This Summer', '', ''],
    ['A28', 'ＮＥＷ　ＰＡＲＡＤＥ　Ｄｅｂｕｔｓ', '', ''],
    ['A29', '新ｼｮｰがｽﾀｰﾄ', '', ''],
    ['A30', '初めてのショー', '', ''],
  ]
  for (const [name, title, summary, bodyText] of accepted) {
    check(name, classifyShow({ title, summary, bodyText }), true)
  }

  const rejected: [string, string, string, string, string][] = [
    [
      'R1',
      'Holiday Parade Merchandise Guide',
      '',
      '',
      'operations/merchandise word',
    ],
    ['R2', 'Parade Schedule Update', '', '', 'no word for newness'],
    ['R3', 'Fireworks Show Returns This Summer', '', '', 'annual return'],
    ['R4', '今年もハロウィーンのパレードが復活', '', '', 'annual return'],
    [
      'R5',
      'Appointment of Independent Non-Executive Directors',
      '',
      '',
      'no show word',
    ],
    ['R6', '人事異動について', '', '', 'no show word'],
    [
      'R7',
      'Indiana Jones et le Temple du Péril : fermeture pour rénovation',
      '',
      '',
      'no show word',
    ],
    [
      'R8',
      'Park Update',
      '',
      `${longFiller}${longFiller}the new parade is great. ${longFiller}`,
      'a single incidental mention deep in the body',
    ],
    [
      'R9',
      'Shanghai Disney Resort Rings in the New Year with Fireworks',
      '',
      '',
      'the new of `New Year`',
    ],
    [
      'R10',
      'Celebrate',
      '',
      `${longFiller}new year's fireworks and new year decorations.`,
      'the new of `New Year`',
    ],
    [
      'R11',
      'JAL、東京ディズニーランド®の新規イースターパレードに協賛',
      '',
      '',
      'sponsorship notice of an existing show',
    ],
    [
      'R12',
      '「東京ディズニーリゾート・スペシャルドローンショー“マジック・イン・ジ・エア”」実施のお知らせ',
      '',
      '',
      'cannot be told apart from an annual event, so rejected',
    ],
    [
      'R13',
      'Fireworks Show Returns with New Finale',
      '',
      '',
      'return of a recurring show (minor change)',
    ],
    [
      'R14',
      'Meet the Performer Who Brings His Heritage Center Stage',
      'A family tradition and a way to honor his heritage.',
      '',
      '`stage` alone is not a show word',
    ],
    [
      'R16',
      'Why Halloween on the High Seas is My New Favorite Fall Tradition',
      '',
      '',
      'no show word',
    ],
    [
      'R17',
      'Live in the Moment and Embrace a Spectacular Summer at Hong Kong Disneyland Resort',
      '',
      '',
      'the adjective spectacular is not a show word',
    ],
    [
      'R15',
      'Hong Kong Disneyland Resort Announces New Pricing Structure',
      '',
      '',
      'no show word',
    ],
    [
      'R18',
      'Parade Schedule Update',
      '',
      'The all-new parade debuts this summer.',
      'a title with an operations word is rejected even if the body has evidence of newness',
    ],
    [
      'R20',
      'New Parade Schedule Update',
      '',
      '',
      'operational information (even with an adjacent new word)',
    ],
    [
      'R21',
      'Brand-new parade merchandise now available',
      '',
      '',
      'merchandise (even with an adjacent new word)',
    ],
    [
      'R22',
      '【最新】ショー公演中止のお知らせ',
      '',
      '',
      'cancellation (the 新 of 最新 is not "new")',
    ],
    [
      'R23',
      'New Fireworks Show Returns This Summer',
      '',
      '',
      'annual return (even with an adjacent new word)',
    ],
    [
      'R24',
      '今年も新パレードが復活',
      '',
      '',
      'annual return (even with an adjacent new word)',
    ],
    [
      'R25',
      '更新情報',
      '',
      '最新情報 ショー',
      'the 新 of 最新 and 更新 is not "new"',
    ],
    ['R26', 'ライブ配信の更新について', '', '', 'live streaming is not a show'],
    [
      'R27',
      'Disney announces strong financial performance',
      '',
      '',
      'performance also means business results, so it is not a title show word',
    ],
    [
      'R28',
      'Cast members launch concert for charity',
      '',
      '',
      'concert is not a title show word even with an announcement word',
    ],
    [
      'R29',
      'Disney announces New Year concert times',
      '',
      '',
      'the new of New Year is not "new"',
    ],
    [
      'R30',
      'Nouveautés du parc : drones',
      '',
      '',
      'nouveau in the middle of a word is not "new"',
    ],
    [
      'R31',
      'Park update',
      '',
      'Enjoy new dining options and shows this season.',
      '"new" and the show word span different noun phrases',
    ],
    [
      'R32',
      'Fireworks Show Reopens, Announced for Friday',
      '',
      '',
      'only a reopening, no evidence of newness',
    ],
    ['R33', '最新ショーのお知らせ', '', '', 'the 新 of 最新 is not "new"'],
    ['R34', '刷新されたショーの映像', '', '', 'the 新 of 刷新 is not "new"'],
    ['R35', '新作ライブ配信のお知らせ', '', '', 'live streaming is not a show'],
    [
      'R36',
      'お知らせ',
      '',
      `新規${'あ'.repeat(20)}ショー`,
      '"new" and the show word are too far apart (upper limit of the gap in a sentence)',
    ],
  ]
  for (const [name, title, summary, bodyText, reason] of rejected) {
    check(
      `${name} (${reason})`,
      classifyShow({ title, summary, bodyText }),
      false
    )
  }

  const startedAt = performance.now()
  const dashes = classifyShow({
    title: 'Update',
    summary: '',
    bodyText: `new ${'-'.repeat(40_000)}x nouveau ${'-'.repeat(40_000)}x`,
  })
  check(
    'R19 (no quadratic time even with a body of long hyphen runs)',
    dashes,
    false
  )
  check(
    'R19 elapsed time is under 1 second',
    performance.now() - startedAt < 1000,
    true
  )
}

/**
 * Reads a saved sample (assumes pnpm is run at the repository root).
 * @param name File name of the sample
 * @returns File content
 */
function readFixture(name: string): string {
  return fs.readFileSync(`src/verify/fixtures/${name}`, 'utf8')
}

/**
 * Verifies that classifyShow agrees with the labels of real articles.
 * Announcements of new shows and parades are positive; sponsorship, annual events, operations, corporate information, pricing and the like are negative.
 * The corpus includes articles used to tune the rules, so it does not guarantee accuracy on unseen articles; it is for detecting regressions.
 */
function verifyLabeledCorpus(): void {
  const items = JSON.parse(readFixture('classifier-corpus.json')) as {
    title: string
    summary: string
    bodyText: string
    expected: boolean
  }[]
  check('corpus: labeled articles', items.length, 35)
  check(
    'corpus: positives and negatives',
    [
      items.filter((item) => item.expected).length,
      items.filter((item) => !item.expected).length,
    ],
    [18, 17]
  )
  check(
    'corpus: every article is classified as labeled',
    items
      .filter((item) => classifyShow(item) !== item.expected)
      .map((item) => item.title),
    []
  )
}

/**
 * Verifies that each parser returns the expected number of candidates for the saved samples.
 */
function verifyParsers(): void {
  const dpbXml = readFixture('dpb.xml')
  check('dpb: all items', parseWordPressFeed(dpbXml, 'x').length, 10)
  const dpb = parseWordPressFeed(dpbXml, resolveDpbRegion)
  check('dpb: target-resort items', dpb.length, 4)
  check('dpb: excluded items', 10 - dpb.length, 6)
  check(
    'dpb: regions',
    dpb.map((candidate) => candidate.region).toSorted(compareText),
    [
      'Disneyland Resort (California)',
      'Walt Disney World Resort (Florida)',
      'Walt Disney World Resort (Florida)',
      'Walt Disney World Resort (Florida)',
    ]
  )

  const paris = parseWordPressFeed(readFixture('paris.xml'), 'Disneyland Paris')
  check('paris: items', paris.length, 10)
  check(
    'paris: title keeps the original text (entities decoded, U+00A0 kept)',
    paris[0].title,
    'Indiana Jones™ et le Temple du Péril : une rénovation d’envergure à partir de janvier 2027'
  )

  check(
    'hk: items',
    parseWordPressFeed(readFixture('hk.xml'), 'Hong Kong Disneyland Resort')
      .length,
    10
  )
  const shanghai = parseWordPressFeed(
    readFixture('shanghai.xml'),
    'Shanghai Disney Resort'
  )
  check('shanghai: items', shanghai.length, 10)
  check(
    'shanghai: every item has a date and an https link',
    shanghai.every(
      (candidate) =>
        candidate.pubDate !== undefined && candidate.link.startsWith('https://')
    ),
    true
  )

  const olc = parseOlcHtml(
    readFixture('olc-news.html.txt'),
    'https://www.olc.co.jp/ja/news.html'
  )
  check('olc: items', olc.length, 12)
  check(
    'olc: first title',
    olc[0].title,
    '日本初のディズニークルーズの船名を「ディズニー・イマジネーション」に決定'
  )
  check(
    'olc: first link is resolved to an absolute url',
    olc[0].link,
    'https://www.olc.co.jp/ja/news/news_olc/20261014_01/main/0/link/20261014_01.pdf'
  )
  check(
    'olc: first date is JST midnight',
    olc[0].pubDate?.toISOString(),
    '2026-10-13T15:00:00.000Z'
  )
  check('olc: region', olc[0].region, 'Tokyo Disney Resort')
}

/**
 * Verifies mergeItems: exclusion of old articles on the first run, carry-over of previous items, identifier normalization and sorting.
 */
function verifyMerge(): void {
  const current = [
    makeItem('a', ago(6 * DAY_MS)),
    makeItem('b', ago(7 * DAY_MS)),
    makeItem('c', ago(7 * DAY_MS + 1000)),
  ]
  check(
    'merge: keeps current items up to 7 days old',
    links(mergeItems(current, [], NOW)),
    [`${BASE_URL}a`, `${BASE_URL}b`]
  )
  check(
    'merge: old current items are not published as new when previous items exist',
    links(
      mergeItems(current, [makeItem('unrelated', ago(DAY_MS))], NOW)
    ).toSorted(compareText),
    [`${BASE_URL}a`, `${BASE_URL}b`, `${BASE_URL}unrelated`]
  )
  check(
    'merge: an old previous item is kept while an old current item is not added',
    links(
      mergeItems(
        [makeItem('old-current', ago(30 * DAY_MS))],
        [makeItem('old-previous', ago(30 * DAY_MS))],
        NOW
      )
    ),
    [`${BASE_URL}old-previous`]
  )

  const previous = [
    makeItem('d89', ago(89 * DAY_MS)),
    makeItem('d90', ago(90 * DAY_MS)),
    makeItem('d90s', ago(90 * DAY_MS + 1000)),
    makeItem('d91', ago(91 * DAY_MS)),
  ]
  check(
    'merge: carries previous items up to 90 days old',
    links(mergeItems([], previous, NOW)),
    [`${BASE_URL}d89`, `${BASE_URL}d90`]
  )

  const overwritten = mergeItems(
    [makeItem('a', ago(DAY_MS), 'new content')],
    [makeItem('a/?x=1#y', ago(2 * DAY_MS), 'old content')],
    NOW
  )
  check(
    'merge: same normalized id gives one item',
    overwritten.map((item) => item.title),
    ['new content']
  )

  const sameTime = ago(DAY_MS)
  check(
    'merge: same pubDate is ordered by link',
    links(
      mergeItems([makeItem('z', sameTime), makeItem('y', sameTime)], [], NOW)
    ),
    [`${BASE_URL}y`, `${BASE_URL}z`]
  )
}

/**
 * Verifies that parsing the previous feed reads both `<item>` inside `<channel>` and the legacy format (`<item>` directly under `<rss>`).
 */
function verifyPreviousFeed(): void {
  const inChannel =
    '<rss version="2.0"><channel><title>t</title>' +
    '<item><title>a</title><link>https://example.com/a</link></item>' +
    '<item><title>b</title><link>https://example.com/b</link></item>' +
    '</channel></rss>'
  check(
    'previous feed: items inside channel',
    parsePreviousFeed(inChannel).map((item) => item.link),
    ['https://example.com/a', 'https://example.com/b']
  )
  const legacySingle =
    '<rss version="2.0"><channel><title>t</title></channel>' +
    '<item><title>a</title><link>https://example.com/a</link></item></rss>'
  check(
    'previous feed: a single legacy item outside channel',
    parsePreviousFeed(legacySingle).map((item) => item.link),
    ['https://example.com/a']
  )
  check(
    'previous feed: no items',
    parsePreviousFeed(
      '<rss version="2.0"><channel><title>t</title></channel></rss>'
    ),
    []
  )
  check(
    'previous feed: a non-RSS response is rejected',
    (() => {
      try {
        parsePreviousFeed('<html><body>maintenance</body></html>')
        return 'no error'
      } catch (error) {
        return error instanceof Error ? error.message : 'unknown'
      }
    })(),
    'Previous feed is not an RSS document'
  )
}

/**
 * Returns whether there is a start tag with an attribute without a value (e.g. `<guid isPermaLink>`).
 * @param xml XML string
 * @returns true if there is an attribute without a value
 */
function hasBareAttribute(xml: string): boolean {
  return /<[A-Za-z][\w:.-]*(?:\s+[\w:.-]+)+\s*>/.test(xml)
}

/**
 * Verifies that the RSS generated from the items returned by collectFrom has no attribute without a value.
 * The RSS is written by an XMLBuilder with the same options as main.ts, and it is also checked that it can be read back as a previous feed.
 */
async function verifyOutputXml(): Promise<void> {
  const service = new DisneyParksNewShows()
  const result = await service.collectFrom(
    [
      makeSource('A', [makeCandidate('a/?x=1', 'New Parade', ago(DAY_MS))]),
      makeFillerSource('B'),
    ],
    [],
    NOW
  )
  const builder = new XMLBuilder({ ignoreAttributes: false, format: true })
  const xml = builder.build({
    rss: {
      '@_version': '2.0',
      channel: { ...service.information(), item: result.items },
    },
  })
  check(
    'output xml: no attribute without a value',
    hasBareAttribute(xml),
    false
  )
  check(
    'output xml: guid has no attribute',
    xml.includes(`<guid>${BASE_URL}a/?x=1</guid>`),
    true
  )
  check(
    'output xml: detects a bare attribute (guard for the check itself)',
    hasBareAttribute('<item><guid isPermaLink>x</guid></item>'),
    true
  )
  check(
    'output xml: items are read back as previous items',
    parsePreviousFeed(xml).map((item) => item.link),
    [`${BASE_URL}a/?x=1`]
  )
}

/**
 * Verifies collectFrom: item conversion, isolation of failing sources and the relation to deleted-article detection.
 */
async function verifyCollect(): Promise<void> {
  const service = new DisneyParksNewShows()

  const converted = await service.collectFrom(
    [
      makeSource('A', [
        makeCandidate('a/?x=1', 'New Parade', ago(DAY_MS)),
        makeCandidate('nodate', 'New Show', undefined),
        {
          ...makeCandidate('js', 'New Show', ago(DAY_MS)),
          link: 'javascript:alert(1)',
        },
        makeCandidate('guide', 'Merchandise Guide', ago(DAY_MS)),
      ]),
      makeSource('B', [
        makeCandidate('a#frag', 'New Parade', ago(DAY_MS), 'B'),
      ]),
      makeFillerSource('C'),
      makeFillerSource('D'),
      makeFillerSource('E'),
    ],
    [],
    NOW
  )
  check('collect: status', converted.status, true)
  check('collect: one item for the same article', converted.items, [
    {
      title: 'New Parade',
      link: `${BASE_URL}a/?x=1`,
      description: '[A, B] s',
      category: 'A, B',
      guid: { '#text': `${BASE_URL}a/?x=1` },
      pubDate: ago(DAY_MS).toUTCString(),
    },
  ])

  const previousItems = [
    makeItem('failed-region', ago(30 * DAY_MS)),
    makeItem('other', ago(10 * DAY_MS)),
  ]
  const isolated = await service.collectFrom(
    [
      makeSource('A', new Error('connection reset')),
      makeSource('B', [makeCandidate('b', 'New Show', ago(2 * DAY_MS), 'B')]),
      makeFillerSource('C'),
      makeFillerSource('D'),
      makeFillerSource('E'),
    ],
    previousItems,
    NOW
  )
  check('isolation: status', isolated.status, true)
  check('isolation: keeps new and previous items', links(isolated.items), [
    `${BASE_URL}b`,
    `${BASE_URL}other`,
    `${BASE_URL}failed-region`,
  ])
  check(
    'isolation: a failed source is not detected as deleted',
    detectDeletedArticles(previousItems, isolated.items, 'DisneyParksNewShows')
      .length,
    0
  )
  const repeated = await service.collectFrom(
    [
      makeSource('A', new Error('connection reset')),
      makeSource('B', [makeCandidate('b', 'New Show', ago(2 * DAY_MS), 'B')]),
      makeFillerSource('C'),
      makeFillerSource('D'),
      makeFillerSource('E'),
    ],
    previousItems,
    NOW
  )
  check('isolation: output is idempotent', repeated, isolated)

  const expired = makeItem('expired', ago(91 * DAY_MS))
  const afterExpiry = await service.collectFrom(
    [
      makeSource('A', [makeCandidate('b', 'New Show', ago(2 * DAY_MS), 'B')]),
      makeFillerSource('B'),
      makeFillerSource('C'),
      makeFillerSource('D'),
      makeFillerSource('E'),
    ],
    [...previousItems, expired],
    NOW
  )
  check(
    'expiry: items older than 90 days are dropped',
    links(afterExpiry.items).includes(expired.link),
    false
  )
  check(
    'expiry: only the expired item is detected as deleted',
    detectDeletedArticles(
      [...previousItems, expired],
      afterExpiry.items,
      'DisneyParksNewShows'
    ).map((article) => article.id),
    [expired.link]
  )

  const allFailed = await service.collectFrom(
    ['A', 'B', 'C', 'D', 'E'].map((name) =>
      makeSource(name, new Error('connection reset'))
    ),
    previousItems,
    NOW
  )
  check('all failed: status', allFailed.status, false)
  const allEmpty = await service.collectFrom(
    ['A', 'B', 'C', 'D', 'E'].map((name) => makeSource(name, [])),
    previousItems,
    NOW
  )
  check('all empty: status', allEmpty.status, false)
}

/**
 * Runs the verification and sets a non-zero exit code if any case fails.
 */
async function main(): Promise<void> {
  verifyClassifier()
  verifyLabeledCorpus()
  verifyParsers()
  verifyMerge()
  verifyPreviousFeed()
  await verifyCollect()
  await verifyOutputXml()

  console.log(`${total - failures}/${total} passed`)
  if (failures > 0) {
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
