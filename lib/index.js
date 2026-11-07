/**
 * dsh-plugin-mcp-toggles — per-session MCP visibility with a user-only switch.
 *
 * Rules:
 * - Every MCP is listed, including project-level ones.
 * - Every MCP is OFF at the start of a session.
 * - Only the user can enable/disable an MCP, from the MCP panel.
 * - The agent has no enable/disable tool; it may call `mcp_list` read-only and
 *   must ask the user to open a disabled MCP.
 * - Global MCPs are unlabelled ("default"); project MCPs are labelled.
 *
 * Global MCP rows stay connected at the profile level and are hidden with an
 * agent-scoped `tools.restrict()` mask. Project MCPs are mounted into the
 * current agent only after the user enables them.
 *
 * @module dsh-plugin-mcp-toggles
 */

import { randomBytes } from 'node:crypto'

import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { normalizeOrigin, originAllowed } from './origin.js'
import { discoverProjectServers, materializeConfig } from './project.js'

export const name = 'mcp-toggles'
export const inject = ['webServer', 'tools', 'sessions', 'agents']

// #region 常量

const API_PREFIX = '/mcp-toggles/api'
const TOKEN_META_NAME = 'dsh-mcp-toggles'
const TOKEN_HEADER = 'x-mcp-toggles-token'
const MAX_BODY_BYTES = 32 * 1024
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'
const SHARED_RESOURCE_TOOLS = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']
const PUBLIC_PREFIX = 'mcp__'
const FALLBACK_PARSE = /^mcp__(.+?)__(.+)$/

/**
 * Per-process mask registry. Hot reload re-evaluates this module; live masks
 * belong to agent scopes, so the registry must survive module replacement.
 */
const MASKS_KEY = Symbol.for('dsh-plugin-mcp-toggles.masks')

/** Stable per-process CSRF token. */
const TOKEN_KEY = Symbol.for('dsh-plugin-mcp-toggles.token')

/** Per-session enabled sets. Intentionally memory-only: a new session starts empty. */
const SESSIONS_KEY = Symbol.for('dsh-plugin-mcp-toggles.sessions')

/** Per-session project MCP fibers and optional tool filters. */
const MOUNTS_KEY = Symbol.for('dsh-plugin-mcp-toggles.mounts')

// #endregion

// #region 配置

/**
 * Resolve the plugin config.
 * @param config Raw row config.
 * @returns Normalized config.
 */
export function resolveConfig(config = {}) {
  return {
    sharedResourceTools: config.sharedResourceTools !== false,
    extraServers: Array.isArray(config.extraServers)
      ? config.extraServers.filter((name) => typeof name === 'string' && name.length > 0)
      : [],
    allowedOrigins: Array.isArray(config.allowedOrigins)
      ? [...new Set(config.allowedOrigins.map(normalizeOrigin).filter(Boolean))]
      : [],
    respectDirectoryOwnership: config.respectDirectoryOwnership === true,
  }
}

// #endregion

// #region 插件

/**
 * Register routes, the read-only `mcp_list` tool, and per-session masks.
 * @param ctx Plugin context.
 * @param rawConfig Row config.
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const log = ctx.logger?.('mcp-toggles') ?? console
  const token = globalThis[TOKEN_KEY] ?? (globalThis[TOKEN_KEY] = randomBytes(32).toString('hex'))

  /**
   * Browser origins allowed to call this API. `webServer.getOrigin()` is the
   * local listener origin; reverse-proxy origins are configured explicitly.
   */
  const allowedOrigins = new Set(config.allowedOrigins)
  try {
    const local = normalizeOrigin(ctx.webServer.getOrigin())
    if (local !== undefined) {
      allowedOrigins.add(local)
      const parsed = new URL(local)
      if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
        allowedOrigins.add(`${parsed.protocol}//127.0.0.1:${parsed.port}`)
        allowedOrigins.add(`${parsed.protocol}//localhost:${parsed.port}`)
      }
    }
  } catch {
    // The listener may not be bound yet; configured origins still apply.
  }

  const installed = globalThis[MASKS_KEY] ??= new Map()
  const sessionStates = globalThis[SESSIONS_KEY] ??= new Map()
  const projectMounts = globalThis[MOUNTS_KEY] ??= new Map()
  const generation = Symbol('mcp-toggles generation')
  const mine = new Set()

  // #region 会话状态

  /**
   * Get one session's memory-only state.
   * @param sessionId Session id.
   * @returns Session state.
   */
  const stateFor = (sessionId) => {
    const key = String(sessionId)
    let state = sessionStates.get(key)
    if (state === undefined) {
      state = { enabled: new Set() }
      sessionStates.set(key, state)
    }
    return state
  }

  /**
   * Whether a server is enabled for one session.
   * @param sessionId Session id.
   * @param serverName Server name.
   * @returns Whether enabled.
   */
  const isEnabled = (sessionId, serverName) => stateFor(sessionId).enabled.has(serverName)

  /**
   * Resolve a session's working directory.
   * @param sessionId Session id.
   * @returns Absolute cwd or undefined.
   */
  const sessionCwd = (sessionId) => {
    try {
      const session = ctx.sessions?.get?.(sessionId)
      if (typeof session?.header?.cwd === 'string') return session.header.cwd
    } catch {}
    const agent = ctx.agents?.list?.().find((candidate) => String(candidate.id) === String(sessionId))
    return typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : undefined
  }

  /**
   * Find the live agent for one session.
   * @param sessionId Session id.
   * @returns Agent or undefined.
   */
  const agentFor = (sessionId) => ctx.agents?.list?.().find((candidate) => String(candidate.id) === String(sessionId))

  // #endregion

  // #region 全局 MCP 目录

  /**
   * Read profile-level MCP rows.
   * @returns Map of serverName to row facts.
   */
  const configuredServers = () => {
    const found = new Map()
    try {
      const editor = ctx.get('configEditor')
      if (editor === undefined) return found
      for (const entry of editor.entries()) {
        if (entry?.options?.name !== MCP_CLIENT_PACKAGE) continue
        const raw = entry.options.config
        if (typeof raw !== 'object' || raw === null) continue
        const serverName = typeof raw.serverName === 'string' ? raw.serverName : undefined
        if (serverName === undefined || serverName.length === 0) continue
        found.set(serverName, {
          name: serverName,
          transport: typeof raw.transport === 'string' ? raw.transport : 'stdio',
          target: typeof raw.url === 'string'
            ? raw.url
            : typeof raw.command === 'string' ? raw.command : '',
          rowId: typeof entry.options.id === 'string' ? entry.options.id : '',
        })
      }
    } catch (error) {
      log?.debug?.(`mcp-toggles: configEditor unavailable: ${String(error?.message ?? error)}`)
    }
    for (const serverName of config.extraServers) {
      if (!found.has(serverName)) found.set(serverName, { name: serverName, transport: 'unknown', target: '', rowId: '' })
    }
    return found
  }

  /**
   * Group root-level MCP tools by server.
   * @returns Map of serverName to public tool names.
   */
  const toolsByServer = () => {
    const grouped = new Map()
    const tools = ctx.tools
    if (tools === undefined) return grouped
    let names = []
    try {
      names = tools.schemas().map((schema) => schema.name)
    } catch (error) {
      log?.warn?.(`mcp-toggles: cannot read global tool schemas: ${String(error?.message ?? error)}`)
      return grouped
    }
    const known = [...configuredServers().keys()].sort((left, right) => right.length - left.length)
    const push = (server, toolName) => {
      const list = grouped.get(server)
      if (list === undefined) grouped.set(server, [toolName])
      else list.push(toolName)
    }
    for (const toolName of names) {
      if (!toolName.startsWith(PUBLIC_PREFIX)) continue
      const matched = known.find((server) => toolName.startsWith(`${PUBLIC_PREFIX}${server}__`))
      if (matched !== undefined) {
        push(matched, toolName)
        continue
      }
      const parsed = FALLBACK_PARSE.exec(toolName)
      if (parsed !== null) push(parsed[1], toolName)
    }
    for (const list of grouped.values()) list.sort()
    return grouped
  }

  /**
   * Profile-level MCP catalog.
   * @param sessionId Session id.
   * @returns Catalog entries.
   */
  const globalCatalog = (sessionId) => {
    const configured = configuredServers()
    const grouped = toolsByServer()
    const names = new Set([...configured.keys(), ...grouped.keys()])
    return [...names].sort((left, right) => left.localeCompare(right)).map((serverName) => {
      const row = configured.get(serverName)
      const toolNames = grouped.get(serverName) ?? []
      return {
        name: serverName,
        source: 'default',
        project: false,
        transport: row?.transport ?? 'unknown',
        target: row?.target ?? '',
        command: row?.target ?? '',
        file: undefined,
        toolNames,
        tools: toolNames.length,
        connected: toolNames.length > 0,
        enabled: isEnabled(sessionId, serverName),
        blocked: undefined,
        configDisabled: false,
      }
    })
  }

  // #endregion

  // #region 项目 MCP 目录

  /**
   * Count tools registered for one project server in an agent scope.
   * @param agent Live agent.
   * @param serverName Server namespace.
   * @returns Public tool names.
   */
  const projectToolNames = (agent, serverName) => {
    try {
      return (agent?.ctx?.tools?.schemas?.() ?? [])
        .map((schema) => schema.name)
        .filter((name) => name.startsWith(`${PUBLIC_PREFIX}${serverName}__`))
    } catch {
      return []
    }
  }

  /**
   * Discover project-level MCPs for one session.
   * @param sessionId Session id.
   * @returns Project catalog entries.
   */
  const projectCatalog = async (sessionId) => {
    const cwd = sessionCwd(sessionId)
    if (cwd === undefined) return []
    const found = await discoverProjectServers(cwd, {
      respectDirectoryOwnership: config.respectDirectoryOwnership,
    })
    const globalNames = new Set(configuredServers().keys())
    const agent = agentFor(sessionId)
    return found.servers.map((server) => {
      const toolNames = projectToolNames(agent, server.serverName)
      const blocked = globalNames.has(server.serverName)
        ? 'duplicate-global'
        : server.configDisabled ? 'config-disabled' : undefined
      return {
        name: server.serverName,
        source: 'project',
        project: true,
        transport: server.transport,
        target: server.command,
        command: server.command,
        file: server.file,
        toolNames,
        tools: toolNames.length,
        connected: toolNames.length > 0,
        enabled: blocked === undefined && isEnabled(sessionId, server.serverName),
        blocked,
        configDisabled: server.configDisabled,
        owner: server.owner,
        config: server.config,
        includeTools: server.includeTools,
        excludeTools: server.excludeTools,
        lifecycle: server.lifecycle,
      }
    })
  }

  /**
   * Combined catalog for one session.
   * @param sessionId Session id.
   * @returns Catalog entries.
   */
  const catalogFor = async (sessionId) => {
    const global = globalCatalog(sessionId)
    const project = await projectCatalog(sessionId)
    return [...global, ...project]
  }

  // #endregion

  // #region 全局掩码

  /**
   * Tools hidden from one session's root global surface.
   * @param sessionId Session id.
   * @param catalog Global catalog.
   * @returns Sorted deny list.
   */
  const globalDenyFor = (sessionId, catalog = globalCatalog(sessionId)) => {
    const state = stateFor(sessionId)
    const deny = []
    for (const server of catalog) {
      if (server.enabled) continue
      deny.push(...server.toolNames)
    }
    if (config.sharedResourceTools && state.enabled.size === 0) deny.push(...SHARED_RESOURCE_TOOLS)
    return [...new Set(deny)].sort()
  }

  /**
   * Remove one session's installed mask.
   * @param sessionId Session id.
   */
  const clearSession = (sessionId) => {
    const previous = installed.get(String(sessionId))
    if (previous === undefined) return
    installed.delete(String(sessionId))
    try {
      previous.dispose?.()
    } catch {}
  }

  /**
   * Install or refresh one agent's global mask.
   * @param agent Live agent.
   * @param catalog Global catalog.
   */
  const applyFor = (agent, catalog) => {
    const sessionId = String(agent.id)
    const deny = globalDenyFor(sessionId, catalog)
    const key = deny.join('\n')
    const previous = installed.get(sessionId)
    if (previous !== undefined && previous.generation === generation && previous.key === key) return
    clearSession(sessionId)
    if (deny.length === 0) return
    const agentTools = agent.ctx?.tools
    if (agentTools === undefined) return
    const record = { generation, key, dispose: undefined }
    installed.set(sessionId, record)
    mine.add(sessionId)
    try {
      record.dispose = ctx.effect(() => agentTools.restrict({ deny }), 'mcp-toggles: mask')
    } catch (error) {
      if (installed.get(sessionId) === record) installed.delete(sessionId)
      mine.delete(sessionId)
      log?.debug?.(`mcp-toggles: cannot install mask for ${sessionId}: ${String(error?.message ?? error)}`)
    }
  }

  let reconciling = false
  let rescan = false

  /** Reconcile every live agent's global mask. */
  const reconcile = () => {
    if (reconciling) {
      rescan = true
      return
    }
    reconciling = true
    try {
      do {
        rescan = false
        for (const agent of ctx.agents?.list?.() ?? []) {
          applyFor(agent, globalCatalog(String(agent.id)))
        }
      } while (rescan)
    } finally {
      reconciling = false
    }
  }

  // #endregion

  // #region 项目 MCP 挂载

  /**
   * Mount one project MCP into the current agent.
   * @param sessionId Session id.
   * @param server Project catalog entry.
   * @returns Result.
   */
  const mountProject = async (sessionId, server) => {
    const key = String(sessionId)
    let mounts = projectMounts.get(key)
    if (mounts === undefined) {
      mounts = new Map()
      projectMounts.set(key, mounts)
    }
    if (mounts.has(server.name)) return { ok: true }
    const agent = agentFor(sessionId)
    if (agent === undefined) return { ok: false, error: 'session-not-live' }
    try {
      const fiber = await agent.ctx.plugin(McpClient, materializeConfig(server))
      mounts.set(server.name, { fiber, server, filterDispose: undefined, filterKey: '' })
      applyProjectFilter(sessionId, server.name)
      return { ok: true }
    } catch (error) {
      log?.warn?.(`mcp-toggles: cannot mount project MCP ${server.name}: ${String(error?.message ?? error)}`)
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * Apply include/exclude tool filters for one mounted project MCP.
   * @param sessionId Session id.
   * @param serverName Server name.
   */
  const applyProjectFilter = (sessionId, serverName) => {
    const record = projectMounts.get(String(sessionId))?.get(serverName)
    if (record === undefined) return
    const include = Array.isArray(record.server.includeTools) ? record.server.includeTools : []
    const exclude = Array.isArray(record.server.excludeTools) ? record.server.excludeTools : []
    if (include.length === 0 && exclude.length === 0) return
    const agent = agentFor(sessionId)
    if (agent?.ctx?.tools === undefined) return
    let names = []
    try {
      names = agent.ctx.tools.schemas().map((schema) => schema.name)
    } catch {
      return
    }
    const prefix = `${PUBLIC_PREFIX}${serverName}__`
    const raw = names.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length))
    const deny = raw
      .filter((name) => (include.length > 0 && !include.includes(name)) || exclude.includes(name))
      .map((name) => `${prefix}${name}`)
    const key = deny.join('\n')
    if (record.filterKey === key) return
    try {
      record.filterDispose?.()
      record.filterKey = key
      record.filterDispose = deny.length === 0 ? undefined : agent.ctx.tools.restrict({ deny })
    } catch {}
  }

  /**
   * Dispose one project MCP mount.
   * @param sessionId Session id.
   * @param serverName Server name.
   */
  const unmountProject = async (sessionId, serverName) => {
    const mounts = projectMounts.get(String(sessionId))
    const record = mounts?.get(serverName)
    if (record === undefined) return
    mounts.delete(serverName)
    try {
      record.filterDispose?.()
    } catch {}
    try {
      await record.fiber?.dispose?.()
    } catch {}
  }

  /**
   * Mount every enabled project MCP for one live session.
   * @param sessionId Session id.
   */
  const mountEnabledProjects = async (sessionId) => {
    const state = stateFor(sessionId)
    if (state.enabled.size === 0) return
    const catalog = await projectCatalog(sessionId)
    for (const server of catalog) {
      if (server.source !== 'project') continue
      if (!state.enabled.has(server.name)) continue
      if (server.blocked !== undefined) continue
      await mountProject(sessionId, server)
    }
  }

  /**
   * Dispose every project mount (plugin unload / session disposal).
   * @param sessionId Optional session id.
   */
  const disposeProjectMounts = async (sessionId) => {
    const keys = sessionId === undefined ? [...projectMounts.keys()] : [String(sessionId)]
    for (const key of keys) {
      const mounts = projectMounts.get(key)
      if (mounts === undefined) continue
      projectMounts.delete(key)
      for (const record of mounts.values()) {
        try {
          record.filterDispose?.()
        } catch {}
        try {
          await record.fiber?.dispose?.()
        } catch {}
      }
    }
  }

  // #endregion

  // #region 事件

  ctx.on('agent/created', (payload) => {
    if (payload?.agent === undefined) return
    reconcile()
    void mountEnabledProjects(String(payload.agent.id)).catch((error) => {
      log?.warn?.(`mcp-toggles: mount after agent/created failed: ${String(error?.message ?? error)}`)
    })
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
    const sessionId = String(agent.id)
    installed.delete(sessionId)
    sessionStates.delete(sessionId)
    void disposeProjectMounts(sessionId)
  })

  ctx.on('tools/change', () => {
    reconcile()
    for (const [sessionId, mounts] of projectMounts) {
      for (const serverName of mounts.keys()) applyProjectFilter(sessionId, serverName)
    }
  })

  ctx.effect(() => {
    reconcile()
    for (const agent of ctx.agents?.list?.() ?? []) {
      void mountEnabledProjects(String(agent.id)).catch(() => {})
    }
    return async () => {
      for (const sessionId of [...mine]) clearSession(sessionId)
      mine.clear()
      await disposeProjectMounts()
    }
  }, 'mcp-toggles: session masks and project mounts')

  // #endregion

  // #region 只读工具

  /**
   * Read-only `mcp_list` tool. It never changes enablement.
   */
  const listTool = defineTool({
    name: 'mcp_list',
    description: [
      'List MCP servers available to this session. Read-only: this tool cannot enable or disable an MCP.',
      'Global MCPs have source "default" and no project label. Project MCPs have source "project".',
      'If a needed MCP is disabled, ask the user to enable it in the MCP panel; do not try to change it yourself.',
    ].join(' '),
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      const sessionId = String(exec.agent.id)
      const catalog = await catalogFor(sessionId)
      const rows = catalog.map((server) => ({
        name: server.name,
        source: server.source,
        project: server.project,
        file: server.file,
        transport: server.transport,
        enabled: server.enabled,
        connected: server.connected,
        tools: server.tools,
        ...(server.blocked === undefined ? {} : { blocked: server.blocked }),
      }))
      return JSON.stringify(rows, null, 2)
    },
  })

  ctx.effect(() => ctx.tools.register(listTool), 'mcp-toggles: mcp_list')

  // #endregion

  // #region 路由

  const sendJson = (res, status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  const readBody = async (req) => {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  const authorizeOrigin = (req) => {
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
    return originAllowed(req.headers.origin, allowedOrigins)
  }

  const authorize = (req) => req.headers[TOKEN_HEADER] === token && authorizeOrigin(req)

  /**
   * Snapshot for the UI.
   * @param sessionId Session id.
   * @returns State payload.
   */
  const snapshot = async (sessionId) => {
    const catalog = await catalogFor(sessionId)
    const servers = catalog
      .slice()
      .sort((left, right) => {
        if (left.source !== right.source) return left.source === 'default' ? -1 : 1
        return left.name.localeCompare(right.name)
      })
      .map((server) => ({
        name: server.name,
        source: server.source,
        project: server.project,
        file: server.file,
        transport: server.transport,
        target: server.target,
        command: server.command,
        connected: server.connected,
        tools: server.tools,
        enabled: server.enabled,
        ...(server.blocked === undefined ? {} : { blocked: server.blocked }),
        ...(server.configDisabled === true ? { configDisabled: true } : {}),
      }))
    return {
      session: sessionId,
      servers,
      enabledCount: servers.filter((server) => server.enabled).length,
      shadowedTools: globalDenyFor(sessionId).length,
      sharedResourceTools: config.sharedResourceTools,
    }
  }

  /**
   * Apply one UI switch.
   * @param sessionId Session id.
   * @param serverName Server name.
   * @param enabled Desired state.
   * @returns Result.
   */
  const setSwitch = async (sessionId, serverName, enabled) => {
    const catalog = await catalogFor(sessionId)
    const server = catalog.find((entry) => entry.name === serverName && entry.source === 'default')
      ?? catalog.find((entry) => entry.name === serverName && entry.source === 'project')
    if (server === undefined) return { ok: false, status: 404, error: 'unknown-server' }
    if (enabled && (server.blocked !== undefined || server.configDisabled === true)) {
      return { ok: false, status: 409, error: server.blocked ?? 'config-disabled' }
    }
    const state = stateFor(sessionId)
    if (enabled) state.enabled.add(serverName)
    else state.enabled.delete(serverName)
    if (server.source === 'project') {
      if (enabled) {
        const result = await mountProject(sessionId, server)
        if (!result.ok) {
          state.enabled.delete(serverName)
          return { ok: false, status: 409, error: result.error ?? 'mount-failed' }
        }
      } else {
        await unmountProject(sessionId, serverName)
      }
    }
    reconcile()
    return { ok: true, persisted: true }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', ctx.webServer.getOrigin())
      const route = url.pathname.slice(API_PREFIX.length) || '/'
      if (!authorize(req)) {
        return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '未授权' } })
      }
      try {
        if (route === '/state' && req.method === 'GET') {
          const sessionId = url.searchParams.get('session')
          if (sessionId === null || sessionId.length === 0) {
            return sendJson(res, 400, { ok: false, error: { code: 'missing-session', message: '缺少会话 id' } })
          }
          return sendJson(res, 200, { ok: true, ...(await snapshot(sessionId)) })
        }
        if (route === '/toggle' && req.method === 'POST') {
          const body = await readBody(req)
          const sessionId = typeof body.session === 'string' ? body.session : ''
          if (sessionId.length === 0) {
            return sendJson(res, 400, { ok: false, error: { code: 'missing-session', message: '缺少会话 id' } })
          }
          if (typeof body.enabled !== 'boolean') {
            return sendJson(res, 400, { ok: false, error: { code: 'invalid-enabled', message: 'enabled 必须是布尔值' } })
          }
          if (typeof body.server !== 'string' || body.server.length === 0) {
            return sendJson(res, 400, { ok: false, error: { code: 'invalid-server', message: 'server 必须是字符串' } })
          }
          const result = await setSwitch(sessionId, body.server, body.enabled)
          if (!result.ok) {
            return sendJson(res, result.status ?? 400, {
              ok: false,
              error: { code: result.error ?? 'failed', message: result.error ?? 'failed' },
            })
          }
          return sendJson(res, 200, { ok: true, persisted: true, ...(await snapshot(sessionId)) })
        }
        return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '未知路由' } })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } })
      }
    },
  }), 'mcp-toggles: routes')

  ctx.effect(() => ctx.webServer.tapIndex((html) => {
    if (html.includes(`name="${TOKEN_META_NAME}"`)) return html
    const meta = `<meta name="${TOKEN_META_NAME}" content="${token}">`
    const head = html.indexOf('</head>')
    return head === -1 ? meta + html : html.slice(0, head) + meta + html.slice(head)
  }), 'mcp-toggles: token meta')

  // #endregion
}
