# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

EdgeOne Pages 边缘函数实现的拉取代理，给 GitHub（clone / raw / release）和 Docker 镜像（Docker Hub、ghcr、gcr、quay、registry.k8s.io）加速。没有构建步骤、没有 npm 依赖、没有测试框架——生产代码就是 `edge-functions/[[default]].js` 一个文件。

## 常用命令

```bash
# 语法检查（文件是 ESM，直接 node --check 会按 CJS 解析报错，必须走 stdin）
node --input-type=module --check < "edge-functions/[[default]].js"

# 本地调试（会打印可访问的本地端口）
edgeone makers dev

# 校验 edgeone.json
edgeone validate

# 部署（项目已存在时 -a 被忽略，但保留以保持一致）
edgeone makers deploy . -n edgeone-proxy -a overseas

# 登录（国际站）
edgeone login -s global
```

临时验证脚本放 `.tmp/` 下，用完删除，不要提交。

## 架构

请求优先级：`public/index.html` 静态命中 `/`，其余所有路径落到 `edge-functions/[[default]].js` 的 `onRequest`。

单函数内的处理链路：

1. `OPTIONS` 直接回 CORS 预检。
2. `resolveRoute(pathname)` 解析上游，返回 `{ host, path }`：
   - `/https://host/path` 完整 URL 形式，仅限白名单主机；
   - 首段 `any` → `/any/<完整URL>` 隐藏开放代理（不对外文档）。解析后只允许 http/https 公网地址，`isPrivateHost` 拦截回环、内网、链路本地和云元数据；代理 URL 的查询串会拼回目标 URL；
   - 首段 `token` → `auth.docker.io/token`；
   - 首段 `v2` → Docker Hub（`registry-1.docker.io`）。若 `/v2/` 后的下一段是 `ghcr|gcr|quay|k8s`，改写为其他仓库并把 `/v2` 前缀补回去——Docker 客户端固定以 `/v2/` 开头，而 `registry-mirrors` 只能配 host，这是两者共存的唯一办法；
   - 其余首段查 `ALIASES`（gh/raw/api/...）或直接命中 `HOST_PREFIXED` 域名。
3. 复制请求头（`Origin` / `Referer` 也透传）→ 强制 `accept-encoding: identity`；非 GET/HEAD 时把 `request.body` 流式直传（`duplex: 'half'`），不整包缓冲。
4. `fetch(target, { redirect: 'follow' })`，GitHub release / codeload 的 302 在函数内跟完。
5. 响应头删除 hop-by-hop、`content-encoding`、`content-length`、CSP，加 CORS，流式返回 `upstream.body`。

修改时的关键不变量：

- **除 `/any/` 外，`HOST_PREFIXED` 是安全边界**（防止变成开放代理）。新增任何上游，必须同时登记到 `HOST_PREFIXED` 和（可选）`ALIASES`，否则一律 404。
- `/any/` 是为了让用户个人临时访问任意公网 URL，刻意绕过白名单，不写进首页/README。它只校验入口 URL 的协议和主机，`redirect: 'follow'` 跟随跳转时不会复检目标（已知残余 SSRF 风险）；不要在这个路由上做鉴权以外的功能扩展。
- **新增 Docker 仓库必须同时配 `TOKEN_PATHS` 和 `REALM_ROUTES`**：前者处理非 `/token` 的取票路径（gcr 是 `/v2/token`、quay 是 `/v2/auth`），后者把 401 的 `www-authenticate` realm 改写成代理自己的 token 入口，否则 docker 客户端会拿着代理地址去请求错误的鉴权地址。
- 不要去掉 `accept-encoding: identity` + 删除 `content-encoding` 的组合：EdgeOne 运行时可能自动解压响应体但保留头，两边不一致会导致文本页面乱码。
- 不支持 WebSocket：Makers 边缘函数是 request/response 模型，运行时没有 `WebSocketPair`。

## 验证方式

没有测试套件。改动后的最小验证：

1. `node` 脚本把 `globalThis.fetch` 换成假的，import 函数后逐条断言 `resolveRoute` 的映射（含 `/v2/<仓库>/` 分流、`/token`、401 realm 重写、未知路径 404）。
2. 部署后用 curl 对线上域名按 docker daemon 的调用顺序跑：`/v2/` 的 401 realm → `/token` 拿票 → manifest → blob 并比对 sha256，再跑一次 `git clone`。

## 平台约束（决定了上面的设计）

- 请求体大小受限：旧的缓冲实现实测 5.0MB 通过、5.02MB 起返回 545（`Error return from script`）；已改为流式直传，上限未重新压测。`docker push` / 大 `git push` 不保证可用。
- CPU 200ms（不含 I/O）、代码包 5MB。
- 国际站 + **overseas 加速区**：中国区节点出网到 `registry-1.docker.io` 会 504，必须用海外区。
- `*.edgeone.dev` 默认域名对**大陆 IP** 只发放 3 小时有效的预览链接，过期 401；绑定自定义域名后正常。域名绑定只能在控制台操作，CLI/API 没有开放接口。
- 线上实例：`https://proxy.labs.l.cd`，项目 `edgeone-proxy`（`makers-rhrvjycgdyxt`），控制台 https://console.tencentcloud.com/edgeone/pages/project/makers-rhrvjycgdyxt 。

`.edgeone/project.json` 是 CLI 的项目链接；`.edgeone/anonymous.json` 是早期匿名部署遗留，可忽略。