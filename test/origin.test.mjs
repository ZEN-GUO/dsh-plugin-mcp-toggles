import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeOrigin, originAllowed, resolveConfig } from '../lib/index.js'

test('normalizeOrigin keeps origin and drops path/trailing slash', () => {
  assert.equal(normalizeOrigin('https://dsh.zenguo.me/'), 'https://dsh.zenguo.me')
  assert.equal(
    normalizeOrigin('https://zen-omen15-linux.tail785d47.ts.net:8443/mcp-toggles/api'),
    'https://zen-omen15-linux.tail785d47.ts.net:8443',
  )
  assert.equal(normalizeOrigin('http://127.0.0.1:3080'), 'http://127.0.0.1:3080')
})

test('normalizeOrigin rejects invalid and non-http(s) values', () => {
  assert.equal(normalizeOrigin('not a url'), undefined)
  assert.equal(normalizeOrigin('ftp://example.com'), undefined)
  assert.equal(normalizeOrigin(''), undefined)
  assert.equal(normalizeOrigin(undefined), undefined)
})

test('originAllowed accepts missing origin, local and configured origins', () => {
  const allowed = new Set(['http://127.0.0.1:3080', 'https://dsh.zenguo.me'])
  assert.equal(originAllowed(undefined, allowed), true)
  assert.equal(originAllowed('', allowed), true)
  assert.equal(originAllowed('http://127.0.0.1:3080', allowed), true)
  assert.equal(originAllowed('https://dsh.zenguo.me/', allowed), true)
  assert.equal(originAllowed('http://127.0.0.1:3080', ['http://127.0.0.1:3080']), true)
})

test('originAllowed rejects unknown, opaque and malformed origins', () => {
  const allowed = new Set(['http://127.0.0.1:3080'])
  assert.equal(originAllowed('https://evil.example', allowed), false)
  assert.equal(originAllowed('null', allowed), false)
  assert.equal(originAllowed('not a url', allowed), false)
})

test('resolveConfig normalizes and deduplicates allowedOrigins', () => {
  const config = resolveConfig({
    allowedOrigins: [
      'https://dsh.zenguo.me/',
      'https://dsh.zenguo.me',
      'https://zen-omen15-linux.tail785d47.ts.net:8443',
      'ftp://ignored.example',
      42,
    ],
  })
  assert.deepEqual(config.allowedOrigins, [
    'https://dsh.zenguo.me',
    'https://zen-omen15-linux.tail785d47.ts.net:8443',
  ])
})
