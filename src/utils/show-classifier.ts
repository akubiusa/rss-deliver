/**
 * Input of the show/parade classification
 */
export interface ClassifyInput {
  /** Original title of the official article */
  title: string
  /** Summary (empty string if none) */
  summary: string
  /** Plain text of the body (empty string if none) */
  bodyText: string
}

/** Unambiguous words for a show (English); also used for title matching */
const STRONG_SHOW_EN = `(?:shows?|parades?|cavalcades?|fireworks|nighttime spectaculars?|night spectaculars?|projection(?: mapping| shows?)?|drone shows?|light shows?|musicals?|theat(?:er|re) shows?)`

/** Words for a show (English). `performance` also means business results, so it is not used for title matching */
const SHOW_EN = `(?:${STRONG_SHOW_EN}|concerts?|performances?)`

/** Words for "new" (English). The "new" of `New Year` is excluded */
const NEW_EN = String.raw`(?:all-new|brand-new|new(?!\s+years?(?![a-z0-9]))|first-ever|never-before-seen)`

/** Words for a show (French, after accent removal) */
const SHOW_FR = `(?:spectacles?|defiles?|parades?|cavalcades?|feux d'artifice|shows?|projections?|drones?)`

/** Words for "new" (French, after accent removal) */
const NEW_FR = `(?:nouveaux?|nouvelles?|inedit(?:e|s|es)?)`

/** Words for a show (Japanese). `ライブ配信` (live streaming) is not a show */
const SHOW_JA = `(?:ショー|パレード|花火|プロジェクション|ミュージカル|ライブ(?!配信)|エンターテイメント|エンターテインメント)`

/** Words for "new" (Japanese). The 新 of `最新` or `更新` is excluded */
const NEW_JA = `(?<![最更刷改])(?:新規|新作|新しい|新たな|新(?=[ァ-ヶー]))|初(?:登場|披露|公演|めて)`

/** Words for the start or premiere of a show (Japanese) */
const START_JA = `(?:スタート|登場|初披露|お披露目|デビュー|開幕|初公演)`

/** Number of leading body characters treated as the lead (to tell the article's subject from incidental mentions) */
const LEAD_LENGTH = 700

/** Number of mentions in the whole body that makes it the article's subject when the lead has none */
const MIN_MENTIONS = 2

/**
 * Word separator (English and French).
 * Must not overlap the word characters `[a-z0-9'&-]`; otherwise the number of ways to split input with consecutive hyphens grows quadratically.
 */
const SEP = String.raw`[\s,:"“”‘’]+`

/** Coordinating or accompanying words that start another noun phrase (English and French). Not allowed between words; `in` and `of` inside show names are allowed */
const BREAK_WORD = `(?:and|or|plus|with|but|et|ou|avec)(?![a-z0-9'&-])`

/** Words allowed in between (English and French). Does not match across another noun phrase */
const WORDS = `(?:(?!${BREAK_WORD})[a-z0-9'&-]+${SEP}){0,3}?`

/** Any characters up to the sentence end (Japanese) */
const JA_GAP = String.raw`[^。\n]`

/**
 * Creates a regular expression with the global flag so that every occurrence can be counted.
 * @param source Regular expression source
 * @returns Global regular expression
 */
function globalPattern(source: string): RegExp {
  return new RegExp(source, 'g')
}

/**
 * Phrases in a sentence that count as an announcement of a new show: "new + show" or "show + debut".
 * A "new" word and a show word merely appearing apart do not match (in a long body any words happen to be close).
 */
const NEW_SHOW_PATTERNS: RegExp[] = [
  globalPattern(
    `(?<![a-z0-9])${NEW_EN}${SEP}${WORDS}(?:${SHOW_EN}|spectaculars?)(?![a-z0-9])`
  ),
  globalPattern(
    String.raw`(?<![a-z0-9])${SHOW_EN}(?![a-z0-9])[^.!?\n]{0,60}?(?<![a-z0-9])(?:debuts?|debuting|premieres?|premiering|unveil(?:s|ed|ing)?|makes its debut)(?![a-z0-9])`
  ),
  globalPattern(`(?<![a-z0-9])${NEW_FR}${SEP}${WORDS}${SHOW_FR}(?![a-z0-9])`),
  globalPattern(`(?<![a-z0-9])${SHOW_FR}${SEP}${WORDS}${NEW_FR}(?![a-z0-9])`),
  globalPattern(`(?:${NEW_JA})${JA_GAP}{0,12}?${SHOW_JA}`),
  globalPattern(`${SHOW_JA}${JA_GAP}{0,30}?${START_JA}`),
]

/** Words that mark a new announcement when the title has a show word (need not be adjacent to it) */
const TITLE_CUE = new RegExp(
  [
    String.raw`(?<![a-z0-9])(?:all-new|brand-new|new(?!\s+years?(?![a-z0-9]))|first-ever|debut(?:s|ing)?|premiere[sd]?|unveil(?:s|ed|ing)?|introduc\w*|announce[sd]?|launch(?:es|ed)?|present(?:s|ing)?|arrives?|coming (?:to|soon|this|next|in))(?![a-z0-9])`,
    String.raw`(?<![a-z0-9])(?:nouveaux?|nouvelles?|inedit\w*|devoile\w*)(?![a-z0-9])`,
    NEW_JA,
    'スタート|登場|デビュー|お披露目|開幕',
  ].join('|')
)

/** Show words for titles. Adjacency is not required, so ambiguous words are excluded */
const TITLE_SHOW = new RegExp(
  `(?<![a-z0-9])${STRONG_SHOW_EN}(?![a-z0-9])|(?<![a-z0-9])${SHOW_FR}(?![a-z0-9])|${SHOW_JA}`
)

/** Words for a sponsorship notice of an existing show. Not a new-show announcement even when a "new" word is adjacent */
const SPONSOR_TITLE = /(?<![a-z0-9])sponsor\w*|協賛|提供/

/** Words for operational information, merchandise and similar. Not a new-show announcement even when a "new" word is adjacent */
const OPERATION_TITLE =
  /(?<![a-z0-9])(?:closures?|schedules?|merchandise|gifts?|recipes?)(?![a-z0-9])|休止|中止|グッズ|fermeture/

/** Words for an annual return. Not a new-show announcement even when a "new" word is adjacent */
const RECURRING_TITLE =
  /(?<![a-z0-9])(?:returns?|returning|back|annual)(?![a-z0-9])|復活|今年も|年度も|revient|retour/

/** Words for a reopening. A "new + show" phrase in the title still wins (a new show announced together with the reopening) */
const REOPEN_TITLE = /(?<![a-z0-9])reopen\w*|再開|reouverture/

/**
 * Normalizes a string for matching.
 * Unifies full-width and half-width forms, removes accents of Latin letters and lowercases.
 * Japanese dakuten (combining characters) are recomposed, not removed.
 * Trademark signs (™, ℠) become `TM` and `SM` under NFKD and would break matches in the middle of a word, so they are removed first.
 * @param text Target string
 * @returns Normalized string
 */
function normalize(text: string): string {
  return text
    .replaceAll(/[™℠]/g, '')
    .normalize('NFKD')
    .replaceAll(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replaceAll('’', "'")
    .normalize('NFKC')
}

/**
 * Returns every string that matches a "new + show" or "show + debut" phrase.
 * @param text Normalized target string
 * @returns Matched strings
 */
function findMatches(text: string): string[] {
  return NEW_SHOW_PATTERNS.flatMap((pattern) =>
    text
      .matchAll(pattern)
      .map((match) => match[0])
      .toArray()
  )
}

/**
 * Returns the matched string that is the evidence for a new show or parade announcement.
 *
 * Rules, in order:
 * 1. Reject if the title is a sponsorship notice, operational information or merchandise, or an annual return.
 * 2. Accept if the title itself has a "new + show" phrase (this wins over a reopening word).
 * 3. Otherwise accept if the title does not indicate a reopening and one of these holds:
 *    - The title has a show word and a word for newness or announcement.
 *    - The summary and the lead of the body have a "new + show" phrase.
 *    - The whole body has a "new + show" phrase several times (the article keeps dealing with a new show).
 * @param input Title, summary and body
 * @returns The matched string (normalized) as evidence, or undefined if rejected
 */
export function findNewShowEvidence(input: ClassifyInput): string | undefined {
  const title = normalize(input.title)
  if (
    SPONSOR_TITLE.test(title) ||
    OPERATION_TITLE.test(title) ||
    RECURRING_TITLE.test(title)
  ) {
    return undefined
  }
  const titleMatches = findMatches(title)
  if (titleMatches.length > 0) {
    return titleMatches.at(0)
  }
  if (REOPEN_TITLE.test(title)) {
    return undefined
  }

  const lead = normalize(
    `${input.title}\n${input.summary}\n${input.bodyText.slice(0, LEAD_LENGTH)}`
  )
  const all = normalize(`${input.title}\n${input.summary}\n${input.bodyText}`)
  const allMatches = findMatches(all)
  const titleCue =
    TITLE_SHOW.test(title) && TITLE_CUE.test(title) ? title : undefined
  return (
    titleCue ??
    findMatches(lead).at(0) ??
    (allMatches.length >= MIN_MENTIONS ? allMatches.at(0) : undefined)
  )
}

/**
 * Classifies by rules whether an article announces a new show, parade or similar.
 * See {@link findNewShowEvidence} for the details.
 * @param input Title, summary and body
 * @returns true if the article is accepted
 */
export function classifyShow(input: ClassifyInput): boolean {
  return findNewShowEvidence(input) !== undefined
}
