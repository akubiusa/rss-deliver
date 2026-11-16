import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  fetchDeletedArticlesHistory,
  getPubDateFromDeletedHistory,
  updateDeletedArticlesHistory,
} from '@/utils/deleted-articles-tracker'

const history = {
  version: '1.0',
  lastUpdated: new Date().toISOString(),
  articles: [
    {
      id: 'article-1',
      title: 'Article',
      link: 'https://example.com/article',
      pubDate: '2026-01-01T00:00:00.000Z',
      deletedAt: new Date().toISOString(),
      serviceName: 'Example',
    },
  ],
}
const originalFetch = fetch

async function verify(): Promise<void> {
  try {
    globalThis.fetch = () =>
      Promise.resolve(new Response(null, { status: 404 }))
    assert.equal(await fetchDeletedArticlesHistory(), null)

    for (const response of [
      () => new Response(null, { status: 503 }),
      () => new Response('invalid json'),
      () => new Response('{}'),
    ]) {
      globalThis.fetch = () => Promise.resolve(response())
      await assert.rejects(fetchDeletedArticlesHistory())
    }
    globalThis.fetch = () => Promise.reject(new Error('Network failure'))
    await assert.rejects(fetchDeletedArticlesHistory())

    globalThis.fetch = () => Promise.resolve(Response.json(history))
    const recovered = await fetchDeletedArticlesHistory()
    const updated = updateDeletedArticlesHistory(recovered, [])
    assert.deepEqual(updated.articles, history.articles)
    assert.equal(
      getPubDateFromDeletedHistory('article-1', updated),
      history.articles[0].pubDate
    )

    const directory = mkdtempSync(path.join(tmpdir(), 'rss-history-'))
    try {
      mkdirSync(path.join(directory, 'output'))
      const historyPath = path.join(
        directory,
        'output',
        'deleted-articles-history.json'
      )
      writeFileSync(historyPath, JSON.stringify(history))
      const driver = path.join(directory, 'driver.mjs')
      const mainUrl = pathToFileURL(path.resolve('src/main.ts')).href
      writeFileSync(
        driver,
        `globalThis.fetch = async () => new Response(null, { status: 503 });\nawait import(${JSON.stringify(mainUrl)});\n`
      )
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          createRequire(path.join(process.cwd(), 'package.json')).resolve(
            'tsx'
          ),
          driver,
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          env: {
            ...process.env,
            TSX_TSCONFIG_PATH: path.resolve('tsconfig.json'),
          },
        }
      )
      assert.notEqual(result.status, 0)
      assert.match(result.stdout + result.stderr, /HTTP 503/)
      assert.deepEqual(JSON.parse(readFileSync(historyPath, 'utf8')), history)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
    console.log('Deleted articles history verification passed')
  } finally {
    globalThis.fetch = originalFetch
  }
}

verify().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
