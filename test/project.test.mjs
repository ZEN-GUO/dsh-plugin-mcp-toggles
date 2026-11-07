import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverProjectServers, materializeConfig } from '../lib/project.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-toggles-'))
  await mkdir(join(root, '.dsh'), { recursive: true })
  await mkdir(join(root, '.pi'), { recursive: true })
  await mkdir(join(root, '.vscode'), { recursive: true })
  await mkdir(join(root, '.codex'), { recursive: true })
  await writeFile(join(root, '.mcp.json'), JSON.stringify({
    mcpServers: {
      universal: { command: 'node', args: ['universal.mjs'] },
      'pi-only': { harness: 'pi', command: 'node', args: ['pi.mjs'] },
      'dsh-explicit': { targets: ['dsh'], command: 'node', args: ['dsh.mjs'] },
    },
  }))
  await writeFile(join(root, '.pi', 'mcp.json'), JSON.stringify({
    mcpServers: {
      'pi-unmarked': { command: 'node', args: ['pi-u.mjs'] },
      'pi-dsh': { harness: 'dsh', command: 'node', args: ['pi-dsh.mjs'] },
    },
  }))
  await writeFile(join(root, '.dsh', 'mcp.yaml'), [
    'mcpServers:',
    '  yaml-test:',
    '    type: stdio',
    '    command: node',
    '    args: ["yaml.mjs"]',
    '    environment:',
    '      YAML_TOKEN: "${YAML_TOKEN}"',
    '',
  ].join('\n'))
  await writeFile(join(root, '.vscode', 'mcp.json'), JSON.stringify({
    servers: { 'vscode-http': { type: 'http', url: 'https://example.com/mcp' } },
  }))
  await writeFile(join(root, '.codex', 'config.toml'), [
    '[mcp_servers.codex-http]',
    'url = "https://example.com/mcp"',
    'bearer_token_env_var = "CODEX_TOKEN"',
    '',
  ].join('\n'))
  await writeFile(join(root, 'opencode.json'), JSON.stringify({
    mcp: { 'oc-test': { type: 'local', command: ['node', 'oc.mjs'] } },
  }))
  return root
}

test('project discovery filters other harnesses but includes universal and explicit DSH', async () => {
  const root = await fixture()
  try {
    const result = await discoverProjectServers(root, { respectDirectoryOwnership: true })
    const names = result.servers.map((server) => server.serverName).sort()
    assert.deepEqual(names, ['dsh-explicit', 'pi-dsh', 'universal', 'yaml-test'])
    const skipped = result.skipped.map((item) => `${item.name}:${item.reason}`).sort()
    assert.deepEqual(skipped, [
      'codex-http:other-harness',
      'oc-test:other-harness',
      'pi-only:other-harness',
      'pi-unmarked:other-harness',
      'vscode-http:other-harness',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('broad mode includes unmarked harness-owned files', async () => {
  const root = await fixture()
  try {
    const result = await discoverProjectServers(root, { respectDirectoryOwnership: false })
    const names = result.servers.map((server) => server.serverName).sort()
    assert.deepEqual(names, ['codex-http', 'dsh-explicit', 'oc-test', 'pi-dsh', 'pi-unmarked', 'universal', 'vscode-http', 'yaml-test'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('project config is materialized only when mounted', async () => {
  const root = await fixture()
  try {
    const result = await discoverProjectServers(root, { respectDirectoryOwnership: true })
    const yaml = result.servers.find((server) => server.serverName === 'yaml-test')
    assert.equal(yaml.config.env.YAML_TOKEN, '${YAML_TOKEN}')
    const materialized = materializeConfig(yaml, { YAML_TOKEN: 'secret-value' })
    assert.equal(materialized.env.YAML_TOKEN, 'secret-value')
    assert.equal(materialized.transport, 'stdio')
    assert.equal(materialized.command, 'node')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
