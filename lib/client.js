/**
 * dsh-plugin-mcp-toggles — 客户端半。
 *
 * 在**会话标题栏**放一个 MCP 选择按钮：点开后列出已安装的 MCP 服务器，
 * 每行一个开关，只作用于当前会话。不占侧栏入口，也没有独立页面 ——
 * 开关就发生在会话本身里。
 *
 * 模块自包含：只依赖平台种子 `react`。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-mcp-toggles',
  factory: (require) => {
    const React = require('react')

    const NS = 'mcp-toggles'
    const API = '/mcp-toggles/api'
    const TOKEN_META = 'dsh-mcp-toggles'

    // #region 文案

    const zh = {
      'picker.title': '选择本会话可用的 MCP 服务器',
      'picker.loading': '读取中…',
      'picker.empty': '没有已安装的 MCP 服务器',
      'picker.emptyHint': '在 设置 → 插件 里安装一个 MCP 服务器后，它会出现在这里。',
      'picker.failed': '读取失败',
      'picker.retry': '重试',
      'picker.scope': '仅本会话生效',
      'picker.scopeDefault': '将用于之后新建的会话',
      'picker.allOn': '全部开启',
      'picker.allOff': '全部关闭',
      'picker.on': '开',
      'picker.off': '关',
      'picker.disconnected': '未连接',
      'picker.tools': '个工具',
      'picker.shadowed': '本会话隐藏',
      'picker.summary.all': '全部开启',
      'picker.summary.none': '全部关闭',
      'picker.summary.pending': '选择 MCP',
      'picker.summary.empty': '无',
      'picker.saving': '保存中…',
      'picker.unsaved': '未写入磁盘',
      'picker.project': '项目 MCP',
      'picker.blocked': '不可开启',
      'picker.refresh': 'MCP 面板令牌缺失，请刷新页面',
    }

    const en = {
      'picker.title': 'Choose the MCP servers this conversation can use',
      'picker.loading': 'Loading…',
      'picker.empty': 'No MCP server is installed',
      'picker.emptyHint': 'Install an MCP server under Settings → Plugins and it shows up here.',
      'picker.failed': 'Load failed',
      'picker.retry': 'Retry',
      'picker.scope': 'Applies to this conversation only',
      'picker.scopeDefault': 'Applies to conversations you start from here',
      'picker.allOn': 'Turn all on',
      'picker.allOff': 'Turn all off',
      'picker.on': 'On',
      'picker.off': 'Off',
      'picker.disconnected': 'not connected',
      'picker.tools': 'tools',
      'picker.shadowed': 'hidden here',
      'picker.summary.all': 'All on',
      'picker.summary.none': 'All off',
      'picker.summary.pending': 'MCP',
      'picker.summary.empty': 'None',
      'picker.saving': 'Saving…',
      'picker.unsaved': 'not written to disk',
      'picker.project': 'Project MCP',
      'picker.blocked': 'unavailable',
      'picker.refresh': 'MCP panel token missing; refresh the page',
    }

    // #endregion

    // #region 令牌与请求

    let cachedToken

    /** 从页面 meta 读令牌；没有 meta 说明页面早于插件加载，需要刷新。 */
    async function token() {
      if (cachedToken !== undefined) return cachedToken
      const meta = document.querySelector(`meta[name="${TOKEN_META}"]`)
      if (meta !== null) {
        const value = meta.getAttribute('content')
        if (value !== null && value.length > 0) {
          cachedToken = value
          return cachedToken
        }
      }
      throw new Error('MCP panel token missing; refresh the page')
    }

    /** 统一请求；非 2xx 抛错并带上服务端消息。 */
    async function api(path, options = {}) {
      const headers = { 'x-mcp-toggles-token': await token() }
      if (options.payload !== undefined) headers['content-type'] = 'application/json'
      const response = await fetch(`${API}${path}`, {
        method: options.method ?? 'GET',
        headers,
        credentials: 'same-origin',
        signal: options.signal,
        ...options.payload === undefined ? {} : { body: JSON.stringify(options.payload) },
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
      return payload
    }

    // #endregion

    // #region 图标

    /** 插头图标：一眼看出这是「连接」类开关。 */
    function PlugGlyph({ size = 15 }) {
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
      },
      React.createElement('path', {
        d: 'M9 3v5M15 3v5',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
      }),
      React.createElement('path', {
        d: 'M6.5 8h11v3.2a5.5 5.5 0 0 1-11 0V8Z',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinejoin: 'round',
      }),
      React.createElement('path', {
        d: 'M12 16.7V21',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
      }))
    }

    /** 小箭头。 */
    function Caret() {
      return React.createElement('svg', {
        width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
      }, React.createElement('path', {
        d: 'm6 9 6 6 6-6',
        stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    // #endregion

    // 样式基准取自 DSH 自身，数值与相邻控件对齐：
    //   · 标题栏正文 14px/20px、圆角 12px、hover 用 --dsw-alias-interactive-bg-hover
    //     （ui-conversation/ConversationRoot.module.css 的 .crumb）
    //   · hero 行控件 28px 高、24px 圆角、13px 字号、透明底
    //     （ui-conversation/PermissionSelect.module.css 的 .trigger）
    //   · 开关 20×10、thumb 6px、缓动 --ds-ease-in-out
    //     （ui-trajectory/TrajectoryToolbar.module.css 的 .controlTrack）
    //   · 浮层阴影用 --dsw-shadow-lv3，不写死 rgba
    // 只用主题 token，不引入任何硬编码颜色。
    const STYLE = `
.mt-wrap { position: relative; display: inline-flex; flex: none; align-self: center; }
.mt-trigger {
  box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 8px; max-width: 220px;
  border: none; border-radius: 24px; outline: none;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family); font-size: 13px; line-height: 20px; font-weight: 500;
  white-space: nowrap; cursor: pointer;
}
.mt-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.mt-trigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
/* 打开态要明显区别于 hover：用与弹层同源的 overlay 实底。
   不用 layer-2 —— 明色下它等于纯白，和页面底色分不开。 */
.mt-trigger[data-open="true"] {
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
}
.mt-trigger[data-open="true"] .mt-name { color: var(--dsw-alias-label-primary); }
.mt-trigger[data-open="true"] .mt-caret { color: var(--dsw-alias-label-secondary); }
/* 全部关闭只降到 tertiary，不用 label-dimmed —— 后者明色是 rgb(225,229,238)，
   在白底上几乎看不见。 */
.mt-trigger[data-none="true"] { color: var(--dsw-alias-label-tertiary); }
.mt-trigger[data-partial="true"] .mt-name { color: var(--dsw-alias-label-primary); }
/* hero 行比标题栏紧凑，与相邻的 workspace／模式控件同高。 */
.mt-trigger[data-compact="true"] { height: 28px; padding: 0 8px; font-size: 13px; }
.mt-icon { flex: none; display: inline-flex; align-items: center; }
.mt-name { overflow: hidden; text-overflow: ellipsis; }
.mt-caret {
  flex: none; display: inline-flex; align-items: center;
  color: var(--dsw-alias-label-caption);
  transition: transform 120ms var(--ds-ease-in-out);
}
.mt-trigger[data-open="true"] .mt-caret { transform: rotate(180deg); }
/* 徽标同样不能用 layer-2：明色下它是纯白，贴在透明触发器上等于没有底色。
   interactive-bg-hover 是 DSH 里用于「轻量底片」的层级，明暗两套都能区分。 */
.mt-badge {
  flex: none; padding: 0 6px; border-radius: 6px;
  font-size: 12px; line-height: 18px; font-weight: 500;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.mt-badge[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.mt-trigger[data-open="true"] .mt-badge { background: var(--dsw-alias-bg-base); }

/* 浮层底色用 --dsw-alias-bg-overlay，不用 --dsw-specific-menu：
   后者等于 --dsw-alias-bg-layer-3，而明色主题下 layer-3 就是 bg-base（纯白），
   白底弹层浮在白页面上等于没有底色。bg-overlay 明色是 bluish-150 浅灰、
   暗色也有独立取值，这才是 DSH 里真正的浮层表面。
   其余沿用 ui-conversation/ContextMeter.module.css 的 .panel：
   lv3 阴影、12px 圆角、z 100。 */
.mt-menu {
  position: absolute; top: calc(100% + 8px); right: 0; z-index: 100;
  box-sizing: border-box;
  width: 360px; max-height: 60vh; overflow-y: auto; padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  background: var(--dsw-alias-bg-overlay); box-shadow: var(--dsw-shadow-lv3);
  font-size: 12px; line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.mt-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: 0 0 8px; padding: 0 0 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary);
}
.mt-headActions { display: inline-flex; align-items: center; gap: 12px; flex: none; }
/* 用 <button> 而非 span：Enter/Space 由浏览器原生处理，键盘可达性无需手写。 */
.mt-link {
  padding: 0; border: none; background: none;
  font-family: var(--dsw-font-family); font-size: 12px; line-height: 20px;
  cursor: pointer; border-radius: 6px;
  color: var(--dsw-alias-label-tertiary);
  transition: color 120ms var(--ds-ease-in-out);
}
.mt-link:hover:not(:disabled) { color: var(--dsw-alias-brand-primary); }
.mt-link:focus-visible { outline: 2px solid var(--dsw-alias-border-l3); outline-offset: 2px; }
.mt-link:disabled { opacity: .5; cursor: default; }
/* 行内边距 -8 抵消浮层的 12px，让 hover 底色铺满整行宽度。 */
.mt-item {
  display: flex; align-items: center; gap: 10px;
  margin: 0 -8px; padding: 8px;
  border-radius: 8px; cursor: default;
}
.mt-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.mt-item[data-busy="true"] { opacity: .6; }
.mt-body { flex: 1; min-width: 0; }
.mt-title {
  display: flex; align-items: center; gap: 6px;
  font-size: 13px; line-height: 20px; font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.mt-sub {
  margin-top: 2px; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mt-project {
  flex: none; padding: 0 6px; border-radius: 6px;
  font-size: 11px; line-height: 18px; font-weight: 500;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
/* 关闭态轨道用 label-caption（明色中灰 rgb(173,178,184)），thumb 用 bg-base
   加 lv1 阴影，保证在轨道上始终有对比。 */
.mt-switch {
  flex: none; position: relative; box-sizing: border-box;
  width: 32px; height: 18px; padding: 0;
  border: none; border-radius: 9px;
  background: var(--dsw-alias-label-caption); cursor: pointer;
  transition: background-color 120ms var(--ds-ease-in-out);
}
.mt-switch::after {
  content: ""; position: absolute; top: 3px; left: 3px;
  width: 12px; height: 12px; border-radius: 50%;
  background: var(--dsw-alias-bg-base);
  box-shadow: var(--dsw-shadow-lv1);
  transition: transform 120ms var(--ds-ease-in-out);
}
/* 开启态用 state-business-primary（明色 rgb(65,118,230) 蓝）。
   不能用 brand-primary —— 它在明色下是 rgb(15,17,21)，接近纯黑。 */
.mt-switch[aria-checked="true"] { background: var(--dsw-alias-state-business-primary); }
.mt-switch[aria-checked="true"]::after { transform: translateX(14px); }
.mt-switch:focus-visible { outline: 2px solid var(--dsw-alias-border-l3); outline-offset: 2px; }
.mt-switch:disabled { opacity: .5; cursor: default; }
.mt-foot {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 0 0;
  font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary);
}
.mt-err {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  padding: 8px 0 0;
  font-size: 12px; line-height: 20px;
  color: var(--dsw-alias-state-error-primary);
}
.mt-btn {
  padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family); font-size: 12px; line-height: 18px;
  cursor: pointer; transition: background-color 120ms var(--ds-ease-in-out);
}
.mt-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.mt-btn:focus-visible { outline: 2px solid var(--dsw-alias-border-l3); outline-offset: 1px; }
.mt-btn:disabled { opacity: .5; cursor: default; }
/* 行内重试按钮跟在错误文字后面，继承错误色的对比度。 */
.mt-btn-inline { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
`

    // #region 选择器

    /**
     * MCP 开关选择器。
     *
     * 同一个组件用于两处：
     *   - `conversation.session.header.utilities`（有会话时的标题栏工具区）；
     *   - `conversation.hero.options`（新会话落地页那一行）。
     *
     * 后者是必需的：新会话页的会话页头带 `hideChrome`，整个 header 都不渲染，
     * 只挂标题栏会让按钮在新会话页上消失。两处都由槽提供 `sessionId`，因此
     * 开关始终绑定在同一个会话上 —— 在新会话页关掉的服务器，进入对话后依然关着。
     * @param props 会话标准 props、`t`，以及可选的 `compact`。
     */
    function McpPicker({ sessionId, t, compact }) {
      const [open, setOpen] = React.useState(false)
      const [state, setState] = React.useState({ phase: 'loading' })
      const [attempt, setAttempt] = React.useState(0)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState()
      const [notice, setNotice] = React.useState()
      const rootRef = React.useRef(null)

      // 开关按会话 id 保存；槽还没给出会话时没有可写的键。
      const scoped = sessionId !== undefined && sessionId !== null && String(sessionId) !== ''
      const sessionKey = scoped ? String(sessionId) : ''

      // 读当前会话的开关快照：首次渲染与每次重试都读。
      React.useEffect(() => {
        if (!scoped) return undefined
        const controller = new AbortController()
        api(`/state?session=${encodeURIComponent(sessionKey)}`, { signal: controller.signal })
          .then((payload) => {
            if (controller.signal.aborted) return
            setState({ phase: 'ready', data: payload })
          }, (reason) => {
            if (controller.signal.aborted) return
            setState({ phase: 'failed', message: reason instanceof Error ? reason.message : String(reason) })
          })
        return () => { controller.abort() }
      }, [scoped, sessionKey, attempt])

      // 工具集合可能在本插件之外变化（服务器重连）；打开时刷新一次。
      React.useEffect(() => {
        if (!open || !scoped) return undefined
        const controller = new AbortController()
        api(`/state?session=${encodeURIComponent(sessionKey)}`, { signal: controller.signal })
          .then((payload) => {
            if (controller.signal.aborted) return
            setState({ phase: 'ready', data: payload })
          }, () => {})
        return () => { controller.abort() }
      }, [open, scoped, sessionKey])

      // 点击外部或 Esc 关闭。
      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const data = state.phase === 'ready' ? state.data : undefined
      const servers = data?.servers ?? []
      const enabledCount = data?.enabledCount ?? 0

      // 徽标只放短状态：长句（无服务器／读取中）会把 220px 的触发器撑破，
      // 完整说明留在弹层里。
      const label = !scoped
        ? t('picker.summary.pending')
        : data === undefined
          ? '…'
          : servers.length === 0
            ? t('picker.summary.empty')
            : enabledCount === servers.length
              ? t('picker.summary.all')
              : enabledCount === 0
                ? t('picker.summary.none')
                : `${enabledCount}/${servers.length}`

      const tone = servers.length > 0 && enabledCount === 0
        ? 'none'
        : servers.length > 0 && enabledCount < servers.length ? 'partial' : 'all'

      /** 写入一个开关（`server` 省略表示整组）。 */
      const toggle = async (server, enabled) => {
        if (!scoped) return
        setBusy(true)
        setError(undefined)
        setNotice(undefined)
        try {
          const payload = await api('/toggle', {
            method: 'POST',
            payload: { session: sessionKey, server, enabled },
          })
          setState({ phase: 'ready', data: payload })
          if (payload.persisted === false) setNotice(t('picker.unsaved'))
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy(false)
        }
      }

      /** 渲染一个服务器行。 */
      const renderRow = (server) => {
        const on = server.enabled === true
        const isProject = server.source === 'project' || server.project === true
        const blocked = server.blocked !== undefined || server.configDisabled === true
        // 副标题只放能一眼比较的短信息；完整命令/来源放进 title。
        const meta = [`${server.tools} ${t('picker.tools')}`, server.transport, isProject ? server.file : undefined]
          .filter(part => part !== undefined && part !== '')
          .join(' · ')
        const detail = [server.name, server.command, server.file, blocked ? server.blocked : undefined]
          .filter(part => part !== undefined && part !== '' && part !== undefined)
          .join(' — ')
        return React.createElement('div', {
          key: server.name,
          className: 'mt-item',
          'data-busy': String(busy),
          title: detail,
        },
        React.createElement('div', { className: 'mt-body' },
          React.createElement('div', { className: 'mt-title' },
            React.createElement('span', null, server.name),
            isProject && React.createElement('span', { className: 'mt-project' }, t('picker.project')),
            blocked && React.createElement('span', { className: 'mt-badge', 'data-tone': 'warn' }, t('picker.blocked'))),
          React.createElement('div', { className: 'mt-sub' }, meta)),
        server.connected !== true && React.createElement('span', {
          className: 'mt-badge', 'data-tone': 'warn',
        }, t('picker.disconnected')),
        React.createElement('button', {
          type: 'button',
          className: 'mt-switch',
          role: 'switch',
          'aria-checked': on,
          'aria-label': server.name,
          disabled: busy || blocked,
          onClick: () => { if (!blocked) void toggle(server.name, !on) },
        }))
      }

      return React.createElement('div', { className: 'mt-wrap', ref: rootRef },
        React.createElement('style', null, STYLE),
        React.createElement('button', {
          type: 'button',
          className: 'mt-trigger',
          'data-open': String(open),
          'data-partial': String(tone === 'partial'),
          'data-none': String(tone === 'none'),
          'data-compact': String(compact === true),
          title: `${t('picker.title')} — ${label}`,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          onClick: () => { setOpen((value) => !value) },
        },
        React.createElement('span', { className: 'mt-icon' }, React.createElement(PlugGlyph, { size: 14 })),
        React.createElement('span', { className: 'mt-name' }, 'MCP'),
        // 徽标保持中性：全部关闭是用户的正常选择，不是错误状态，
        // 用警示橙会在标题栏里显得刺眼。
        React.createElement('span', { className: 'mt-badge' }, label),
        React.createElement('span', { className: 'mt-caret' }, React.createElement(Caret))),

        open && React.createElement('div', {
          className: 'mt-menu',
          role: 'dialog',
          'aria-label': t('picker.title'),
        },
        React.createElement('div', { className: 'mt-head' },
          React.createElement('span', null, scoped ? t('picker.scope') : t('picker.scopeDefault'))),

        !scoped && React.createElement('div', { className: 'mt-foot' }, t('picker.scopeDefault')),
        scoped && state.phase === 'loading'
          && React.createElement('div', { className: 'mt-foot' }, t('picker.loading')),
        state.phase === 'failed' && React.createElement('div', { className: 'mt-err' },
          React.createElement('span', null, `${t('picker.failed')}: ${state.message}`),
          React.createElement('button', {
            type: 'button',
            className: 'mt-btn mt-btn-inline',
            onClick: () => {
              setState({ phase: 'loading' })
              setAttempt((value) => value + 1)
            },
          }, t('picker.retry'))),

        data !== undefined && servers.length === 0 && React.createElement('div', { className: 'mt-foot' },
          t('picker.emptyHint')),

        servers.map(renderRow),

        error !== undefined && React.createElement('div', { className: 'mt-err' }, error),
        notice !== undefined && React.createElement('div', { className: 'mt-foot' }, notice),
        busy && React.createElement('div', { className: 'mt-foot' }, t('picker.saving'))))
    }

    // #endregion

    // #region 插件

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-toggles: dictionaries')

        // 会话标题栏右侧工具区：选择器天然绑定当前会话。
        ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'mcp-toggles',
          order: -7,
          locale: NS,
        }, McpPicker)), 'mcp-toggles: header picker')

        // 新会话落地页那一行。必需：该页的会话页头整体带 `hideChrome`
        // （`blank && composerPhase === 'blank'`），只挂标题栏会让按钮在
        // 新会话页上完全消失。
        ctx.effect(() => ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
          name: 'conversation.hero.options',
          id: 'mcp-toggles-hero',
          order: 20,
          locale: NS,
        }, (props) => React.createElement(McpPicker, { ...props, compact: true }))),
        'mcp-toggles: hero picker')
      },
    }
  },
})
