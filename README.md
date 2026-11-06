# dsh-plugin-mcp-toggles

[![npm version](https://img.shields.io/npm/v/dsh-plugin-mcp-toggles.svg)](https://www.npmjs.com/package/dsh-plugin-mcp-toggles)
[![npm downloads](https://img.shields.io/npm/dm/dsh-plugin-mcp-toggles.svg)](https://www.npmjs.com/package/dsh-plugin-mcp-toggles)
[![license](https://img.shields.io/npm/l/dsh-plugin-mcp-toggles.svg)](LICENSE)
[![node](https://img.shields.io/node/v/dsh-plugin-mcp-toggles.svg)](package.json)

为**每个会话**单独开关已安装的 MCP 服务器。

装好之后，会话标题栏右侧（新会话页则是输入卡片上方那一行）会出现一个 **MCP**
按钮，点开列出已安装的 MCP 服务器，每行一个开关，**只影响当前会话**。

## 安装

用 DSH 自带的插件命令，装进你要用的 profile：

```bash
dsh plugin --profile web add dsh-plugin-mcp-toggles
```

把 `web` 换成你的 profile 名（`desktop`、`tui`、`headless` 等）。这条命令会
把它加入该 profile 的依赖与 bundle 列表，然后重启 DSH 即可。

指定版本或改用 GitHub 源：

```bash
dsh plugin --profile web add dsh-plugin-mcp-toggles@0.1.0
dsh plugin --profile web add github:ZhaoHanshao/dsh-plugin-mcp-toggles
```

卸载：

```bash
dsh plugin --profile web remove dsh-plugin-mcp-toggles
```

> 在 DSH 会话里，也可以让 agent 用 `plugin_manager action=install_bundle
> target=dsh-plugin-mcp-toggles` 完成同样的安装。

## 用法

1. 打开任意会话 —— 或直接停在**新会话页**。
2. 点标题栏（新会话页则是输入卡片上方那一行）的 **MCP** 按钮。
3. 逐行开关，或点 `全部开启` / `全部关闭`。

按钮上的徽标显示当前状态：`全部开启`、`n/m`、`全部关闭`；部分关闭时按钮转为警示色。

开关立即生效，无需重启会话或重开服务器。

## 它解决什么

MCP 服务器在 DSH profile 里是进程级的：`@deepseek-ai/dsh-mcp-client` 每行连一个
服务器，把 `mcp__<serverName>__<tool>` 注册进**全局**工具层。于是每个会话都看到
同一批 MCP 工具 —— 想让 A 会话只用 REA、B 会话只用别的服务器，原生做不到。

本插件把这份「全局可见」变成「按会话可见」。**新会话默认全部开启**，所以装上它
不会悄悄改变任何人现有的能力；只有你亲手关掉的服务器才会在该会话里消失。

## 它怎么工作

`agent.ctx.tools.restrict({ deny })` 是**作用域内**生效的全局工具掩码。可见性、
schema 投影与派发都走同一个解析器，因此被关掉的工具模型既看不到也调不到，其他
会话完全不受影响。

- 关闭某服务器 → 把它的 `mcp__<server>__*` 工具加进该会话的 deny 集。
- 全部服务器都关闭时，共享的 `list_mcp_resources` 等资源工具一并隐藏
  （`sharedResourceTools: false` 可关掉这个联动）。
- 掩码按 deny 指纹幂等：工具集变化时只重算、不重复叠加。

## 两个入口，同一个开关集合

| 槽位 | 出现位置 |
|---|---|
| `conversation.session.header.utilities` | 已有会话的标题栏右侧 |
| `conversation.hero.options` | 新会话落地页，紧跟 workspace 与模式控件之后 |

两处**必须都有**：新会话页的会话页头带 `hideChrome`
（`blank && composerPhase === 'blank'`），此时整个 header 都不渲染，只挂标题栏会让
按钮在新会话页上完全消失。两个槽都提供同一个 `sessionId`，所以在哪一处切换都是
同一个会话的开关 —— 在新会话页关掉的服务器，进入对话后依然关着。

## 开关存在哪

`$DSH_HOME/mcp-toggles-state.json`：

```json
{ "bySession": { "<sessionId>": { "rea": false } } }
```

键是 sessionId。**没有记录即视为开启** —— 只会记录「关掉」，所以新会话、以及删掉
状态文件之后的会话，都回到全部开启。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `mcp-toggles` 这一行的 `config`：

| 字段 | 默认 | 含义 |
|---|---|---|
| `sharedResourceTools` | `true` | 关闭全部 MCP 时是否连共享资源工具一起隐藏。 |
| `extraServers` | `[]` | 额外要认作 MCP 服务器的名字；用于服务器暂时没有注册任何工具时也能列出来。 |
| `allowedOrigins` | `[]` | 额外允许调用本插件 API 的浏览器 Origin。监听器的本地 Origin 总是允许；通过 Tailscale Serve、反向代理或自定义域名访问时，把浏览器实际使用的 `https://...` Origin 加到这里。 |

例如通过 Tailscale Serve 访问：

```yaml
- id: mcp-toggles
  name: dsh-plugin-mcp-toggles
  config:
    sharedResourceTools: true
    allowedOrigins:
      - https://zen-omen15-linux.tail785d47.ts.net:8443
      - https://dsh.zenguo.me
```

> `webServer.getOrigin()` 返回的是本地监听地址（如 `http://127.0.0.1:3080`），
> 不是 `--public-url`。所以远程访问必须显式配置 `allowedOrigins`，否则浏览器
> 的 POST 会带公网 `Origin` 并被拒绝，表现为“能看到列表但所有开关都未授权”。

## 兼容性

- **DSH**：需要 `@deepseek-ai/dsh-client-ui-conversation` ≥ `0.2.1-rc.3`
  （提供上述两个槽位与 `webServer` 服务）。这条写进了 `peerDependencies` 并标记为
  可选 —— DSH 把这些包内置在安装目录里，普通 npm 安装不该再拉一份副本。
- **Node**：`^22.19.0 || >=24.0.0`，与 DSH 官方下限一致。

## 已知限制

- 只管理 **MCP** 工具（`mcp__*` 前缀与共享资源工具），不动其他工具。
- 服务器列表来自 `configEditor.entries()` 里的 `@deepseek-ai/dsh-mcp-client` 行；
  `configEditor` 不可用时退回当前工具名前缀，此时**没有工具**的服务器不会出现在列表里。
- 开关按会话 id 保存；会话被删除后对应记录会保留（无害，不会影响其他会话）。

## 开发

没有依赖、没有构建步骤，`lib/` 就是发布内容。改完直接检查：

```bash
npm run prepublishOnly    # node --check 两个入口
npm pack --dry-run        # 查看将要发布的文件
```

## License

MIT
