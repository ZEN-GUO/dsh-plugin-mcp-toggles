/**
 * dsh-plugin-mcp-toggles — 让每个会话单独决定哪些 MCP 服务器对模型可见。
 *
 * ## 为什么需要它
 * MCP 服务器在 profile 里是**进程级**的：`@deepseek-ai/dsh-mcp-client` 每行
 * 连一个服务器，并把 `mcp__<serverName>__<tool>` 注册到**全局**工具层。于是
 * 每个会话都看得到同一批 MCP 工具 —— 想在一个会话里只用 REA、在另一个会话
 * 里只用别的服务器，原生做不到。
 *
 * ## 实际使用的机制
 * `agent.ctx.tools.restrict({ deny })` 是作用域内生效的**全局工具掩码**
 * （见 `packages/core/tools/src/index.ts` 的 `restrict`）：只影响该 agent
 * 的可见工具集，schema 投影、查找与派发都走同一个解析器，因此模型既看不到
 * 也调不到被关掉的工具，而其他会话完全不受影响。
 *
 * 每个会话的开关存在 `$DSH_HOME/mcp-toggles-state.json`：键是 sessionId，
 * 值是 `{ [serverName]: boolean }`。未记录即视为开启 —— 装上插件不会悄悄
 * 关掉任何人的 MCP。
 *
 * @module dsh-plugin-mcp-toggles
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'mcp-toggles'
export const inject = ['webServer']

// #region 常量

/** API 前缀（与客户端半的常量保持一致）。 */
const API_PREFIX = '/mcp-toggles/api'

/** 页面 meta 名：客户端据此拿到同源令牌。 */
const TOKEN_META_NAME = 'dsh-mcp-toggles'

/** 请求头名。 */
const TOKEN_HEADER = 'x-mcp-toggles-token'

/** 请求体上限。 */
const MAX_BODY_BYTES = 32 * 1024

/** mcp-client 的包名：`configEditor.entries()` 里它就是 MCP 行。 */
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** 由 `@deepseek-ai/dsh-mcp-resources` 注册的共享资源工具。 */
const SHARED_RESOURCE_TOOLS = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']

/** 工具名前缀 / 分隔：`mcp__<serverName>__<rawName>`。 */
const PUBLIC_PREFIX = 'mcp__'

/** 从 `mcp__<server>__<tool>` 里取回服务器名的兜底解析。 */
const FALLBACK_PARSE = /^mcp__(.+?)__(.+)$/

/**
 * 进程级掩码登记表的键。
 *
 * Hot reload 会重新求值本模块，模块级的 Map 随之丢掉，而 `restrict()` 装下的
 * 掩码属于 agent 作用域、并不随模块销毁 —— 旧 disposer 一旦丢失，那层掩码就
 * 永久生效，表现为「某些会话突然看不到 MCP 工具且开关无效」。因此登记表放在
 * 全局，新模块直接接手上一代留下的记录并可以正常撤销。
 */
const MASKS_KEY = Symbol.for('dsh-plugin-mcp-toggles.masks')

/**
 * Stable per-process CSRF token. Hot reload re-evaluates this module; a fresh
 * token would invalidate the meta tag of an already-open page, so keep one
 * token for the process lifetime.
 */
const TOKEN_KEY = Symbol.for('dsh-plugin-mcp-toggles.token')

// #endregion

// #region 配置

/**
 * Normalize one HTTP Origin value to its serialized origin.
 * Invalid values and non-HTTP(S) schemes are rejected.
 * @param value Raw Origin header or configured value.
 * @returns The normalized origin, or `undefined`.
 */
export function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/**
 * Whether a request Origin is acceptable. A missing Origin is allowed: the
 * random header token still protects state-changing requests.
 * @param origin The request `Origin` header, when present.
 * @param allowed Set/array of normalized origins.
 * @returns Whether the origin is allowed.
 */
export function originAllowed(origin, allowed) {
  if (origin === undefined || origin === null || origin === '') return true
  const normalized = normalizeOrigin(origin)
  if (normalized === undefined) return false
  if (allowed instanceof Set) return allowed.has(normalized)
  return Array.isArray(allowed) && allowed.includes(normalized)
}

/**
 * 解析插件配置。
 * @param config 来自 `cordis.patch.yml` 的原始配置。
 * @returns 归一化后的配置。
 */
export function resolveConfig(config = {}) {
  return {
    /**
     * 共享的 MCP 资源工具（`list_mcp_resources` 等）是否跟随整体开关：
     * 只有当前会话关掉了**全部** MCP 服务器时才隐藏它们。
     */
    sharedResourceTools: config.sharedResourceTools !== false,
    /** 额外需要识别为 MCP 服务器的名字（服务器暂时没有工具时也能列出）。 */
    extraServers: Array.isArray(config.extraServers)
      ? config.extraServers.filter((name) => typeof name === 'string' && name.length > 0)
      : [],
    /**
     * Extra browser origins allowed to call this plugin's API. The listener's
     * local origin is always allowed; public reverse-proxy origins (Tailscale
     * Serve, a custom domain) must be listed here.
     */
    allowedOrigins: Array.isArray(config.allowedOrigins)
      ? [...new Set(config.allowedOrigins.map(normalizeOrigin).filter(Boolean))]
      : [],
  }
}

// #endregion

// #region 选择存储

/** 状态文件。 */
function stateFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'mcp-toggles-state.json')
}

/** 读取持久化的每会话开关；坏文件退回空状态，不影响使用。 */
function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf8'))
    const bySession = parsed?.bySession
    if (typeof bySession !== 'object' || bySession === null) return { bySession: {} }
    /** @type {Record<string, Record<string, boolean>>} */
    const clean = {}
    for (const [sessionId, entry] of Object.entries(bySession)) {
      if (typeof entry !== 'object' || entry === null) continue
      const row = {}
      for (const [server, enabled] of Object.entries(entry)) {
        if (typeof enabled === 'boolean') row[server] = enabled
      }
      clean[sessionId] = row
    }
    return { bySession: clean }
  } catch {
    return { bySession: {} }
  }
}

/** 写回持久化开关；失败只影响下次启动，不影响本次运行。 */
function saveState(state) {
  try {
    mkdirSync(dirname(stateFile()), { recursive: true })
    writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

// #endregion

// #region 插件

/**
 * 注册路由，并按会话装配 MCP 工具掩码。
 * @param ctx 插件上下文。
 * @param rawConfig 行配置。
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const log = ctx.logger?.('mcp-toggles') ?? console
  // 用加密随机源而非 Math.random：这枚令牌是唯一挡住跨站改写的东西。
  // 令牌跨热重载保持稳定，避免已打开页面的 meta 立即失效。
  const token = globalThis[TOKEN_KEY] ?? (globalThis[TOKEN_KEY] = randomBytes(32).toString('hex'))
  const state = loadState()

  /**
   * Browser origins allowed to call this API. `webServer.getOrigin()` is the
   * listener's local origin (for example `http://127.0.0.1:3080`), never the
   * reverse proxy's public origin; remote deployments must list their public
   * origins in `allowedOrigins`.
   */
  const allowedOrigins = new Set(config.allowedOrigins)
  try {
    const local = normalizeOrigin(ctx.webServer.getOrigin())
    if (local !== undefined) {
      allowedOrigins.add(local)
      const parsed = new URL(local)
      const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
      if (loopback) {
        allowedOrigins.add(`${parsed.protocol}//127.0.0.1:${parsed.port}`)
        allowedOrigins.add(`${parsed.protocol}//localhost:${parsed.port}`)
      }
    }
  } catch {
    // The listener may not be bound yet; configured origins still apply.
  }

  /**
   * 每个会话当前已装的掩码：`key` 是生效的 deny 指纹，用于幂等判断
   * （`restrict` 会触发 `tools/change`，指纹相同就不再重装，避免自激）。
   *
   * 跨模块代际共享（见 {@link MASKS_KEY}）：热重载后新模块接手旧记录，也就能
   * 撤销旧一代装下的掩码，不会留下永久生效的孤儿。
   * @type {Map<string, { key: string, dispose?: () => void }>}
   */
  const installed = globalThis[MASKS_KEY] ??= new Map()

  /**
   * 本代模块的身份。
   *
   * 插件热重载会先卸载旧一代：旧一代的 `ctx.effect` 随插件上下文销毁，掩码
   * 已经撤销，但共享登记表里还留着旧记录。只比 deny 指纹会把这种**已失效**的
   * 记录误当成现役状态，于是新会话看不到应有的工具掩码。因此记录带上代际，
   * 只有本代亲手装的记录才算现役。
   */
  const generation = Symbol('mcp-toggles generation')

  /** 本代模块亲手装过的会话；卸载时只清理这些，不误伤下一代接手的记录。 */
  const mine = new Set()

  // #region 服务器目录

  /**
   * 读 `configEditor` 里所有 MCP 行，拿到 serverName 与连接参数事实。
   *
   * 这一步只用于**列出**：即使某个服务器当前一个工具都没连上，用户也能在
   * 选择器里看到它并预先关掉。`configEditor` 缺失或被禁用时返回空数组。
   * @returns serverName → 行事实。
   */
  const configuredServers = () => {
    /** @type {Map<string, { name: string, transport: string, target: string, rowId: string }>} */
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
      // configEditor 可能因 profile 只读或版本差异不可用；列不出服务器并不
      // 妨碍已连接服务器的开关，所以这里只记录一次。
      log?.debug?.(`mcp-toggles: configEditor unavailable: ${String(error?.message ?? error)}`)
    }
    for (const serverName of config.extraServers) {
      if (found.has(serverName)) continue
      found.set(serverName, { name: serverName, transport: 'unknown', target: '', rowId: '' })
    }
    return found
  }

  /**
   * 从全局工具视图里按服务器归组 MCP 工具。
   *
   * 优先用 `configEditor` 给的名字做前缀匹配（服务器名本身可能含 `__`），
   * 再用 `mcp__<server>__<tool>` 兜底解析没匹配上的名字。
   * @returns serverName → 公开工具名列表。
   */
  const toolsByServer = () => {
    /** @type {Map<string, string[]>} */
    const grouped = new Map()
    const tools = ctx.get('tools')
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
   * 当前进程里可开关的 MCP 服务器：已配置的行 ∪ 当前有工具的服务器。
   * @returns 按名字排序的服务器目录。
   */
  const serverCatalog = () => {
    const configured = configuredServers()
    const grouped = toolsByServer()
    const names = new Set([...configured.keys(), ...grouped.keys()])
    return [...names].sort((left, right) => left.localeCompare(right)).map((serverName) => {
      const row = configured.get(serverName)
      return {
        name: serverName,
        transport: row?.transport ?? 'unknown',
        target: row?.target ?? '',
        tools: grouped.get(serverName) ?? [],
        connected: grouped.has(serverName),
      }
    })
  }

  // #endregion

  // #region 开关与掩码

  /**
   * 某会话里某个服务器是否开启；没有显式记录即视为开启。
   * @param sessionId 会话 id。
   * @param serverName 服务器名。
   * @returns 是否对该会话可见。
   */
  const isEnabled = (sessionId, serverName) => state.bySession[sessionId]?.[serverName] !== false

  /**
   * 计算某会话应当被 deny 的全局工具名。
   * @param sessionId 会话 id。
   * @param catalog 一次性读到的服务器目录。
   * @returns 排序后的工具名列表。
   */
  const denyFor = (sessionId, catalog) => {
    const deny = []
    for (const server of catalog) {
      if (isEnabled(sessionId, server.name)) continue
      deny.push(...server.tools)
    }
    if (config.sharedResourceTools && catalog.length > 0
      && catalog.every(server => !isEnabled(sessionId, server.name))) {
      deny.push(...SHARED_RESOURCE_TOOLS)
    }
    return deny.sort()
  }

  /** 撤掉某会话已装的掩码。 */
  const clearSession = (sessionId) => {
    const previous = installed.get(sessionId)
    if (previous === undefined) return
    installed.delete(sessionId)
    try { previous.dispose?.() } catch {}
  }

  /**
   * 为一个会话重算并装上掩码。**只在 {@link reconcile} 内部调用。**
   *
   * `restrict()` 与它返回的 disposer 都会**同步**发出 `tools/change`；若允许
   * 在这两次调用之间重入，就会装出第二层掩码，随后被覆盖的记录再也撤销不掉
   * —— 表现为「关掉能生效、再打开不生效」。{@link reconcile} 用一次性重试把
   * 这种同步重入折叠成收尾的一轮，这里因此可以按「先摘旧、再装新」的直线顺序写。
   *
   * 掩码注册在 `agent.ctx` 上（`restrict` 只接受作用域上下文），但登记**持有者**
   * 是本插件的 `ctx.effect`：作用域上下文与插件上下文都会在销毁时调用同一个
   * disposer，因此插件热重载或会话销毁都不会留下抹不掉的掩码。
   * @param agent 目标 agent。
   * @param catalog 复用的服务器目录。
   */
  const applyFor = (agent, catalog) => {
    const sessionId = String(agent.id)
    const deny = denyFor(sessionId, catalog)
    const key = deny.join('\n')
    const previous = installed.get(sessionId)
    // 只有本代装下的、指纹相同的记录才算已就位。
    if (previous !== undefined && previous.generation === generation && previous.key === key) return
    clearSession(sessionId)
    if (deny.length === 0) return
    const agentTools = agent.ctx?.tools
    if (agentTools === undefined) return
    const record = { generation, key, dispose: undefined }
    installed.set(sessionId, record)
    // 记录本代装过哪些会话：卸载时只清自己的记录，不动下一代已经接手的那批。
    mine.add(sessionId)
    try {
      // 用插件自己的 ctx 包一层 effect，让掩码有第二个持有点。
      record.dispose = ctx.effect(() => agentTools.restrict({ deny }), 'mcp-toggles: mask')
      log?.debug?.(`mcp-toggles: session ${sessionId} hides ${deny.length} MCP tool(s)`)
    } catch (error) {
      // `restrict` 对未知名字抛错：服务器刚断线时工具可能在两次读取之间消失。
      // 收尾那一轮会用新的名字集合重算，所以这里不放大成故障。
      if (installed.get(sessionId) === record) installed.delete(sessionId)
      mine.delete(sessionId)
      log?.debug?.(`mcp-toggles: cannot install mask for ${sessionId}: ${String(error?.message ?? error)}`)
    }
  }

  /** 正在对账；期间到来的变更折叠成收尾的一轮。 */
  let reconciling = false
  /** 对账期间是否又有变更要求重算。 */
  let rescan = false

  /**
   * 对全部在线 agent 对账一次。
   *
   * 与 `tools/change` 的自激靠两层挡住：deny 指纹相同的会话直接跳过；期间的
   * 同步重入只置 `rescan`，不嵌套执行，收尾时再跑一轮。
   */
  const reconcile = () => {
    if (reconciling) {
      rescan = true
      return
    }
    reconciling = true
    try {
      do {
        rescan = false
        const catalog = serverCatalog()
        const agents = ctx.get('agents')
        for (const agent of agents?.list?.() ?? []) applyFor(agent, catalog)
      } while (rescan)
    } finally {
      reconciling = false
    }
  }

  // 新会话：装配它的掩码；已存在的会话在插件加载时补装。
  ctx.on('agent/created', (payload) => {
    if (payload?.agent !== undefined) reconcile()
  })
  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    // 掩码注册在 agent 作用域上，随作用域一起销毁，这里只丢弃记录。
    if (agent !== undefined) installed.delete(String(agent.id))
  })
  // 工具集合变化（服务器重连、工具列表更新）：对账，指纹挡住自激。
  ctx.on('tools/change', () => { reconcile() })

  ctx.effect(() => {
    reconcile()
    return () => {
      // 只清本代装过的会话：下一代模块在重载时已接手同一张表，误清会连带
      // 撤销它刚装好的掩码。
      for (const sessionId of [...mine]) clearSession(sessionId)
      mine.clear()
    }
  }, 'mcp-toggles: per-session masks')

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

  /**
   * Origin/site check shared by the token bootstrap and every API call.
   * Allowed origins include the listener's local origin and configured public
   * origins, so Tailscale Serve and a public domain work without weakening
   * cross-site protection.
   */
  const authorizeOrigin = (req) => {
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
    return originAllowed(req.headers.origin, allowedOrigins)
  }

  /** 同源 + 令牌校验。 */
  const authorize = (req) => {
    if (req.headers[TOKEN_HEADER] !== token) return false
    return authorizeOrigin(req)
  }

  /** 某会话的状态投影，供选择器渲染。 */
  const snapshot = (sessionId) => {
    const catalog = serverCatalog()
    const servers = catalog.map(server => ({
      name: server.name,
      transport: server.transport,
      target: server.target,
      tools: server.tools.length,
      connected: server.connected,
      enabled: isEnabled(sessionId, server.name),
    }))
    return {
      session: sessionId,
      servers,
      enabledCount: servers.filter(server => server.enabled).length,
      sharedResourceTools: config.sharedResourceTools,
      shadowedTools: denyFor(sessionId, catalog).length,
      installed: installed.has(sessionId),
    }
  }

  /** 写入某会话的一个开关，并对该会话立即生效。 */
  const setSwitch = (sessionId, serverName, enabled) => {
    const row = state.bySession[sessionId] ?? (state.bySession[sessionId] = {})
    if (enabled) delete row[serverName]
    else row[serverName] = false
    if (Object.keys(row).length === 0) delete state.bySession[sessionId]
    const persisted = saveState(state)
    reconcile()
    return persisted
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', ctx.webServer.getOrigin())
      const route = url.pathname.slice(API_PREFIX.length) || '/'

      if (route === '/token' && req.method === 'GET') {
        // Bootstrap token for a page that loaded before this plugin. Restrict
        // it to same-origin/allowlisted callers so a cross-site page cannot
        // read the CSRF token.
        if (!authorizeOrigin(req)) {
          return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '未授权' } })
        }
        return sendJson(res, 200, { token })
      }
      if (!authorize(req)) {
        return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '未授权' } })
      }

      try {
        if (route === '/state' && req.method === 'GET') {
          const sessionId = url.searchParams.get('session')
          if (sessionId === null || sessionId.length === 0) {
            return sendJson(res, 400, { ok: false, error: { code: 'missing-session', message: '缺少会话 id' } })
          }
          return sendJson(res, 200, { ok: true, ...snapshot(sessionId) })
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
          // `server === null` 表示整组开/关。
          if (body.server === null || body.server === undefined) {
            const catalog = serverCatalog()
            for (const server of catalog) {
              const row = state.bySession[sessionId] ?? (state.bySession[sessionId] = {})
              if (body.enabled) delete row[server.name]
              else row[server.name] = false
            }
            if (state.bySession[sessionId] !== undefined
              && Object.keys(state.bySession[sessionId]).length === 0) {
              delete state.bySession[sessionId]
            }
            const persisted = saveState(state)
            reconcile()
            return sendJson(res, 200, { ok: true, persisted, ...snapshot(sessionId) })
          }
          if (typeof body.server !== 'string' || body.server.length === 0) {
            return sendJson(res, 400, { ok: false, error: { code: 'invalid-server', message: 'server 必须是字符串' } })
          }
          const known = serverCatalog().some(server => server.name === body.server)
          if (!known) {
            return sendJson(res, 404, {
              ok: false,
              error: { code: 'unknown-server', message: `未安装的 MCP 服务器：${body.server}` },
            })
          }
          const persisted = setSwitch(sessionId, body.server, body.enabled)
          return sendJson(res, 200, { ok: true, persisted, ...snapshot(sessionId) })
        }

        return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '未知路由' } })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } })
      }
    },
  }), 'mcp-toggles: routes')

  // 页面早于插件加载时，客户端从 meta 拿令牌；插件的 tap 负责把它写进去。
  ctx.effect(() => ctx.webServer.tapIndex((html) => {
    if (html.includes(`name="${TOKEN_META_NAME}"`)) return html
    const meta = `<meta name="${TOKEN_META_NAME}" content="${token}">`
    const head = html.indexOf('</head>')
    return head === -1 ? meta + html : html.slice(0, head) + meta + html.slice(head)
  }), 'mcp-toggles: token meta')

  // #endregion
}

// #endregion
