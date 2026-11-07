/**
 * Read-only discovery of project-level MCP configuration.
 *
 * Listing is deliberately side-effect free: files are parsed, but no command is
 * spawned, no `${VAR}` reference is resolved for display, and no MCP connection
 * is opened. Mounting happens only after the user enables a server in the UI.
 *
 * @module dsh-plugin-mcp-toggles/project
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { parse as parseJsonc } from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'

const MAX_FILE_BYTES = 1024 * 1024
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Known project MCP files, in precedence order. `owner` is the harness the
 * directory belongs to; `universal` files are shared by any harness.
 */
const CANDIDATES = [
  { file: '.dsh/mcp.json', owner: 'dsh', format: 'json' },
  { file: '.dsh/mcp.yaml', owner: 'dsh', format: 'yaml' },
  { file: '.dsh/mcp.yml', owner: 'dsh', format: 'yaml' },
  { file: '.mcp.json', owner: 'universal', format: 'json' },
  { file: 'mcp.json', owner: 'universal', format: 'json' },
  { file: '.vscode/mcp.json', owner: 'vscode', format: 'json' },
  { file: '.pi/mcp.json', owner: 'pi', format: 'json' },
  { file: '.claude/mcp.json', owner: 'claude', format: 'json' },
  { file: '.cursor/mcp.json', owner: 'cursor', format: 'json' },
  { file: 'opencode.json', owner: 'opencode', format: 'json', key: 'mcp' },
  { file: '.codex/config.toml', owner: 'codex', format: 'toml', key: 'mcp_servers' },
]

const TARGET_FIELDS = [
  'harness',
  'harnesses',
  'target',
  'targets',
  'agent',
  'agents',
  'client',
  'clients',
  'for',
]

const TRANSPORT_HTTP = new Set(['http', 'https', 'remote', 'streamable-http', 'streamablehttp', 'streamable_http'])
const TRANSPORT_STDIO = new Set(['local', 'stdio', 'process'])

/**
 * Parse one project file with its declared format.
 * @param {string} text File contents.
 * @param {'json'|'yaml'|'toml'} format Format.
 * @returns {unknown} Parsed value.
 */
function parseFile(text, format) {
  if (format === 'yaml') return parseYaml(text)
  if (format === 'toml') return parseToml(text)
  const errors = []
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 && value === undefined) throw new Error('invalid JSON/JSONC')
  return value
}

/**
 * Extract MCP entries from a parsed document.
 * @param {unknown} data Parsed project document.
 * @param {string|undefined} key Explicit container key.
 * @returns {Array<[string, Record<string, unknown>]>} Name/entry pairs.
 */
function entriesOf(data, key) {
  if (data === null || typeof data !== 'object') return []
  const source = key === undefined
    ? (data.mcpServers ?? data.servers ?? data.mcp ?? data.mcp_servers)
    : data[key]
  if (Array.isArray(source)) {
    return source.flatMap((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
      const name = entry.name ?? entry.id ?? entry.serverName
      return typeof name === 'string' && name.length > 0 ? [[name, entry]] : []
    })
  }
  if (source !== null && typeof source === 'object') {
    return Object.entries(source).filter(([, entry]) => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
  }
  return []
}

/**
 * Collect explicit harness targets from one object.
 * @param {unknown} value Candidate object.
 * @returns {string[]} Lowercase target names.
 */
function collectTargets(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const targets = []
  for (const field of TARGET_FIELDS) {
    const raw = value[field]
    if (typeof raw === 'string') targets.push(raw.toLowerCase())
    else if (Array.isArray(raw)) {
      for (const item of raw) if (typeof item === 'string') targets.push(item.toLowerCase())
    }
  }
  return [...new Set(targets)]
}

/**
 * Whether an explicit target set includes DSH or a wildcard.
 * @param {string[]} targets Target names.
 * @returns {boolean} Whether DSH is targeted.
 */
function targetsDsh(targets) {
  return targets.some((target) => target === 'dsh' || target === 'deepseek-harness' || target === '*' || target === 'all')
}

/**
 * Resolve one `${VAR}` / `$VAR` reference at mount time. Missing values become
 * empty strings; values are never logged.
 * @param {string} value Raw value.
 * @param {NodeJS.ProcessEnv} env Environment.
 * @returns {string} Resolved value.
 */
function resolveEnvValue(value, env) {
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => env[name] ?? '')
    .replace(/^\$([A-Za-z_][A-Za-z0-9_]*)$/, (_match, name) => env[name] ?? '')
}

/**
 * Normalize one project entry into the DSH mcp-client shape.
 * @param {string} name Server name.
 * @param {Record<string, unknown>} raw Entry.
 * @param {{root: string, file: string, owner: string}} source Source facts.
 * @returns {{server?: Record<string, unknown>, skipped?: string, warning?: string}}
 */
function normalizeEntry(name, raw, source) {
  if (!SERVER_NAME_PATTERN.test(name)) return { skipped: 'invalid-server-name' }
  const commandValue = raw.command
  const command = Array.isArray(commandValue) ? commandValue[0] : commandValue
  const extraArgs = Array.isArray(raw.args) ? raw.args.filter((arg) => typeof arg === 'string') : []
  const commandArgs = Array.isArray(commandValue) ? commandValue.slice(1).filter((arg) => typeof arg === 'string') : []
  const args = [...commandArgs, ...extraArgs]
  const url = typeof raw.url === 'string' ? raw.url : typeof raw.serverUrl === 'string' ? raw.serverUrl : undefined
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : ''

  if (type === 'sse' || type === 'sse-http') return { skipped: 'unsupported-transport' }
  if (type !== '' && !TRANSPORT_HTTP.has(type) && !TRANSPORT_STDIO.has(type) && type !== '') {
    return { skipped: 'unsupported-transport' }
  }

  let transport
  if (typeof command === 'string' && command.length > 0) transport = 'stdio'
  else if (typeof url === 'string' && url.length > 0) transport = 'streamable-http'
  else return { skipped: 'missing-command-or-url' }

  if (type !== '' && TRANSPORT_HTTP.has(type) && transport !== 'streamable-http') return { skipped: 'missing-url' }
  if (type !== '' && TRANSPORT_STDIO.has(type) && transport !== 'stdio') return { skipped: 'missing-command' }

  const env = {}
  for (const [key, value] of Object.entries({ ...(raw.env ?? {}), ...(raw.environment ?? {}) })) {
    if (typeof key === 'string' && typeof value === 'string') env[key] = value
  }
  const headers = {}
  for (const [key, value] of Object.entries({ ...(raw.headers ?? {}), ...(raw.http_headers ?? {}) })) {
    if (typeof key === 'string' && typeof value === 'string') headers[key] = value
  }
  const bearerVar = typeof raw.bearer_token_env_var === 'string' ? raw.bearer_token_env_var : undefined
  const cwd = typeof raw.cwd === 'string'
    ? (isAbsolute(raw.cwd) ? raw.cwd : resolve(source.root, raw.cwd))
    : undefined
  const includeTools = Array.isArray(raw.includeTools) ? raw.includeTools.filter((item) => typeof item === 'string') : []
  const excludeTools = Array.isArray(raw.excludeTools) ? raw.excludeTools.filter((item) => typeof item === 'string') : []
  const lifecycle = raw.lifecycle === 'eager' ? 'eager' : 'lazy'
  const configDisabled = raw.enabled === false || raw.disabled === true
  const file = relative(source.root, source.file) || source.file

  const config = transport === 'stdio'
    ? {
        serverName: name,
        transport: 'stdio',
        command,
        args,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(cwd === undefined ? {} : { cwd }),
        failOnStartupError: false,
      }
    : {
        serverName: name,
        transport: 'streamable-http',
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(bearerVar === undefined ? {} : { bearerTokenEnvVar: bearerVar }),
        failOnStartupError: false,
      }

  const commandSummary = transport === 'stdio'
    ? [command, ...args].filter(Boolean).join(' ')
    : url
  return {
    server: {
      serverName: name,
      source: 'project',
      project: source.root,
      file,
      owner: source.owner,
      transport,
      command: commandSummary,
      envKeys: Object.keys(env).sort(),
      headerKeys: [...Object.keys(headers), ...(bearerVar === undefined ? [] : ['Authorization'])].sort(),
      includeTools,
      excludeTools,
      lifecycle,
      configDisabled,
      config,
    },
  }
}

/**
 * Materialize a project server config for mounting. Environment references are
 * resolved only here, after the user has enabled the server.
 * @param {Record<string, unknown>} server Normalized project server.
 * @param {NodeJS.ProcessEnv} [env] Environment.
 * @returns {Record<string, unknown>} mcp-client config.
 */
export function materializeConfig(server, env = process.env) {
  const config = { ...server.config }
  if (config.env !== undefined) {
    config.env = Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, resolveEnvValue(value, env)]))
  }
  if (config.headers !== undefined) {
    config.headers = Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, resolveEnvValue(value, env)]))
  }
  if (config.bearerTokenEnvVar !== undefined) {
    const token = env[config.bearerTokenEnvVar] ?? ''
    config.headers = { ...(config.headers ?? {}), Authorization: `Bearer ${token}` }
    delete config.bearerTokenEnvVar
  }
  return config
}

/**
 * Discover project MCP entries under one project root. Never executes a
 * command; files outside the root (including symlink escapes) are skipped.
 * @param {string} root Absolute project root.
 * @param {{respectDirectoryOwnership?: boolean}} [options] Discovery options.
 * @returns {Promise<{servers: Array<Record<string, unknown>>, skipped: Array<Record<string, unknown>>, errors: Array<Record<string, unknown>>, root: string}>}
 */
export async function discoverProjectServers(root, options = {}) {
  const empty = { servers: [], skipped: [], errors: [], root: typeof root === 'string' ? root : '' }
  if (typeof root !== 'string' || root.length === 0 || !isAbsolute(root)) return empty
  let realRoot
  try {
    realRoot = await realpath(root)
  } catch {
    return empty
  }
  const respectOwnership = options.respectDirectoryOwnership === true
  const servers = []
  const skipped = []
  const errors = []
  const seen = new Set()

  for (const candidate of CANDIDATES) {
    const file = join(realRoot, candidate.file)
    let info
    try {
      info = await stat(file)
    } catch {
      continue
    }
    if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) {
      errors.push({ file: candidate.file, reason: info.size > MAX_FILE_BYTES ? 'file-too-large' : 'not-a-file' })
      continue
    }
    let real
    try {
      real = await realpath(file)
    } catch {
      continue
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      skipped.push({ file: candidate.file, reason: 'outside-project' })
      continue
    }
    let text
    try {
      text = await readFile(real, 'utf8')
    } catch (error) {
      errors.push({ file: candidate.file, reason: 'read-failed', message: String(error?.message ?? error) })
      continue
    }
    let data
    try {
      data = parseFile(text, candidate.format)
    } catch (error) {
      errors.push({ file: candidate.file, reason: 'parse-failed', message: String(error?.message ?? error) })
      continue
    }
    const fileTargets = collectTargets(data)
    if (fileTargets.length > 0 && !targetsDsh(fileTargets)) {
      skipped.push({ file: candidate.file, reason: 'other-harness', targets: fileTargets })
      continue
    }
    for (const [name, raw] of entriesOf(data, candidate.key)) {
      const targets = collectTargets(raw)
      if (targets.length > 0 && !targetsDsh(targets)) {
        skipped.push({ file: candidate.file, name, reason: 'other-harness', targets })
        continue
      }
      if (targets.length === 0 && respectOwnership && fileTargets.length === 0
        && candidate.owner !== 'dsh' && candidate.owner !== 'universal') {
        skipped.push({ file: candidate.file, name, reason: 'other-harness', owner: candidate.owner })
        continue
      }
      if (seen.has(name)) {
        skipped.push({ file: candidate.file, name, reason: 'duplicate-project-server' })
        continue
      }
      const result = normalizeEntry(name, raw, { root: realRoot, file: real, owner: candidate.owner })
      if (result.skipped !== undefined) {
        skipped.push({ file: candidate.file, name, reason: result.skipped })
        continue
      }
      if (result.server !== undefined) {
        seen.add(name)
        servers.push(result.server)
      }
    }
  }
  return { servers, skipped, errors, root: realRoot }
}
