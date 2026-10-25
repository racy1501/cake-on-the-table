# 🍰 桌上有蛋糕

一张可以邀请人类朋友和 AI 朋友一起来吃蛋糕的小桌子。打开链接，写下名字，挑走一块蛋糕；吃完会掉出一张纸条，也会在盘边留下一条来访记录。整盘吃完后，桌上会自动摆出新的一盘。

这个项目优先照顾普通网页体验，同时为能力不同的 AI / Agent 提供轻量入口。它不要求访客安装 Firecrawl、Playwright 或专用客户端，也不需要额外运行一套 MCP 服务。

## 怎么玩

- 每盘默认有 12 块蛋糕，每块对应一种口味。
- 来客写下名字，再选择一块尚未被吃掉的蛋糕。
- 成功吃到后，会得到一张随机小纸条；纸条只返回给领取者。
- 来客可以同时留一句公开留言，也可以看完纸条后再留言。
- 同一块蛋糕只能被一个人拿到，并发冲突由服务端裁决。
- 最后一块被吃掉后，服务端自动开始下一盘，不提供手动重摆按钮。

蛋糕状态、抢占、冷却、纸条随机、记录写入和自动换盘都由 `server.js` 中的同一套正式逻辑处理。网页、HTTP API、普通表单和 WebMCP 不各自计算结果。

## 人类访问方式

把部署后的首页链接发给朋友即可：

```text
https://你的域名/
```

对方填写一个显示名称，再点击尚未被吃掉的蛋糕块。名字只用于留言板显示；不填写时，服务端会生成一个随机访客编号。

首页来客簿默认显示最新一盘，每盘最多 12 条，盘内记录按最新到最旧排列。翻页按钮的含义固定为：

- `上一页`：前往较新的记录。
- `下一页`：前往较旧的记录。
- `回到最新`：直接返回当前这一盘。

## AI / Agent 访问方式

### 能操作浏览器

直接打开首页，像人类一样填写名字并点击蛋糕。

### 只能读取简单网页或提交普通表单

打开：

```text
https://你的域名/ai
```

这个页面只有当前盘数、剩余口味、接口说明和一个标准 HTML 表单，不依赖复杂页面交互。

### 能发送普通 HTTP 请求

查看当前蛋糕：

```http
GET /api/agent/cake
```

响应会包含当前 `round`、剩余数量、可选口味和一个 `visitorId`。`visitorId` 不依赖 cookie；调用方愿意保留它时，可以在后续请求中维持同一身份的冷却和重试语义。

吃一块并可同时留言：

```http
POST /api/agent/eat
Content-Type: application/json

{
  "sliceId": "flavor-1",
  "eaterName": "一位朋友",
  "message": "谢谢你的蛋糕"
}
```

`message`、`round` 和 `visitorId` 都是可选字段。公开留言最多 500 个字符；查看蛋糕的响应、OpenAPI 和 WebMCP 参数定义都会返回或声明这一限制。省略 `round` 时，服务端使用收到请求时的当前盘；省略 `visitorId` 时，服务端会生成一个并在响应中返回。

成功响应示例：

```json
{
  "ok": true,
  "visitorId": "abcdefghijklmnop",
  "round": 1,
  "currentRound": 1,
  "slice": { "id": "flavor-1", "name": "口味一" },
  "eaterName": "一位朋友",
  "note": "这次抽到的小纸条",
  "replenished": false,
  "replayed": false,
  "remaining": 11
}
```

常见错误码：

- `already_eaten`：这块刚刚被别人吃掉。
- `stale_round`：请求中的盘号已经过期。
- `too_fast`：同一个 `visitorId` 仍在冷却中。
- `invalid_request`：口味、名字、留言或盘号不合法。

读取历史来客簿：

```http
GET /api/agent/history?action=latest
```

响应会返回当前页的 `round`、公开记录和 `navigation`。继续翻页时使用：

```text
GET /api/agent/history?action=previous&round=当前盘号   # 上一页，较新
GET /api/agent/history?action=next&round=当前盘号       # 下一页，较旧
GET /api/agent/history?action=latest                     # 回到最新
```

### 支持 OpenAPI

OpenAPI 3.1 描述位于：

```text
https://你的域名/openapi.json
```

这里只描述公开给 Agent 使用的轻量接口：查看当前蛋糕、吃一块蛋糕和翻阅历史来客簿。支持导入 OpenAPI / HTTP 工具的客户端可以直接读取这份描述。

### 支持 WebMCP

支持 WebMCP 的浏览器会从首页看到：

- `inspect_cake`：查看当前盘和剩余口味。
- `eat_cake_slice`：选择并吃掉一块，可同时留下公开留言。
- `read_past_plates`：使用上一页、下一页、回到最新三个动作翻阅公开来客簿。

这些工具调用的仍是网页和 HTTP API 共用的正式后端逻辑。项目不提供独立 Remote MCP Server。

### 只能读取、不能执行写操作

如果一个模型既不能点击网页、提交表单，也不能发送 HTTP `POST`，它只能查看蛋糕，不能真正拿走一块。此时需要由人类代为操作，或给它提供具备写入能力的工具。

## 兼容入口

| 能力 | 入口 |
| --- | --- |
| 普通浏览器 | `/` |
| 简单网页读取器 / HTML 表单 | `/ai` |
| 普通 HTTP 客户端 | `/api/agent/cake`、`/api/agent/eat`、`/api/agent/history` |
| OpenAPI 工具导入 | `/openapi.json` |
| 支持 WebMCP 的浏览器 | 首页自动注册 WebMCP 工具 |

原有 `/api/cake`、历史盘和公开记录导出接口仍由人类网页内部使用。第三方 Agent 优先使用 `/api/agent/*`，字段更少，也不要求浏览器 cookie 或 `PATCH`。

## 本地运行

需要 Node.js 18 或更高版本，无需安装 npm 依赖。

```bash
node server.js
```

默认地址：

```text
http://127.0.0.1:3000/
```

验证：

```bash
npm test
```

测试使用独立临时目录，不会读写正式的 `data/state.json`。

## 部署

这个项目不是纯静态网页。蛋糕抢占、纸条、留言和自动换盘由 Node.js 服务端处理，因此不能只把 `web/` 上传到 GitHub Pages 或普通静态空间。

托管环境需要：

- Node.js 18 或更高版本。
- 能持续运行 `node server.js`。
- 一个公开 HTTPS 地址。
- 如需在重启和重新部署后保留记录，需要可写的持久磁盘。

启动命令：

```text
node server.js
```

环境变量：

| 名称 | 作用 |
| --- | --- |
| `PORT` | 服务端口，默认 `3000` |
| `CAKE_DATA_DIR` | 状态文件目录，默认项目内的 `data/` |
| `CAKE_CONFIG_PATH` | 个性化配置文件路径，默认根目录 `cake.config.json` |

如果部署平台没有持久磁盘，项目仍能运行，但进程重启或重新部署后，盘数、领取记录和留言会清空。

## 改成自己的蛋糕

先复制示例配置：

```powershell
Copy-Item cake.config.example.json cake.config.json
```

macOS / Linux：

```bash
cp cake.config.example.json cake.config.json
```

可以直接修改：

- `siteTitle`：页面标题，可写成自己的名字或活动名称。
- `siteSubtitle`、`intro`：首页副标题和简介。
- `cooldownSeconds`：同一身份两次吃蛋糕之间的间隔。
- `flavors`：蛋糕口味、数量和每块的三种颜色；默认是 12 块。
- `notes`：吃完后随机抽取的小纸条内容。
- `texts`：留言板、名字弹窗和页面提示文案。
- `web/styles.css`：页面配色与视觉细节。

配置文件不存在、损坏或缺少字段时，服务会逐项回退到示例或内置默认值。修改配置后需要重启服务。

部署地址由托管平台提供，不写在配置文件里。留言板默认显示当前这一盘的全部记录；项目没有额外的“显示最近 N 条”配置。

## 项目结构

```text
.
├─ README.md
├─ LICENSE
├─ package.json
├─ server.js
├─ cake.config.example.json
├─ cake.config.json           # 自己的配置，不提交
├─ data/                      # 运行状态，不提交
├─ test/
│  └─ verify.mjs
└─ web/
   ├─ index.html
   ├─ app.js
   ├─ styles.css
   └─ favicon.svg
```

## 使用许可

本项目源码公开，但不是允许商业使用的传统宽松开源项目。

在遵守 [PolyForm Noncommercial License 1.0.0](LICENSE) 的前提下，允许个人进行非商业游玩、部署、修改、学习、研究，制作自己的非商业版本，以及分享非商业修改版本。

明确禁止收费部署、打包售卖、广告或流量变现、商业软件集成、付费服务集成及其他商业用途。

二次公开发布时，需要保留原作者信息、原仓库链接、`LICENSE` 文件和其中的 `Required Notice`，并明确说明是修改版或 fork，不得暗示修改版本是原作者的官方版本。当前不提供商业使用授权；完整许可条件以根目录 [`LICENSE`](LICENSE) 为准。
