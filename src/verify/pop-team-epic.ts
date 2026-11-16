import assert from 'node:assert/strict'
import PopTeamEpic from '@/services/pop-team-epic'

const series =
  '<meta property="og:title" content="Title"><meta property="og:image" content="https://example.com/image.jpg">'
const originalFetch = fetch

async function verify(): Promise<void> {
  const cases = [
    { name: 'HTTP failure', body: '', status: 503 },
    { name: 'malformed XML', body: '<rss><channel></rss>', status: 200 },
    {
      name: 'missing items',
      body: '<rss><channel></channel></rss>',
      status: 200,
    },
    {
      name: 'unusable item',
      body: '<rss><channel><item><title>Title</title></item></channel></rss>',
      status: 200,
    },
  ]

  try {
    for (const testCase of cases) {
      globalThis.fetch = (input) =>
        Promise.resolve(
          (input instanceof Request ? input.url : input.toString()).endsWith(
            '/rss'
          )
            ? new Response(testCase.body, { status: testCase.status })
            : new Response(series)
        )
      await assert.rejects(new PopTeamEpic().collect(), Error, testCase.name)
    }

    globalThis.fetch = (input) =>
      Promise.resolve(
        new Response(
          (input instanceof Request ? input.url : input.toString()).endsWith(
            '/rss'
          )
            ? '<rss><channel><item><title>Episode</title><link>https://example.com/episode</link></item></channel></rss>'
            : series
        )
      )
    assert.deepEqual(await new PopTeamEpic().collect(), {
      status: true,
      items: [],
    })
    console.log('PopTeamEpic RSS verification passed')
  } finally {
    globalThis.fetch = originalFetch
  }
}

void verify()
