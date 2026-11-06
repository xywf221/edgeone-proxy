# EdgeOne GitHub / Docker 代理

基于腾讯云 EdgeOne Pages 边缘函数的单文件反向代理：一个域名同时给 **GitHub**（clone / raw / release 下载）和 **Docker 镜像拉取**（Docker Hub、GHCR、GCR、Quay、registry.k8s.io）加速。

无服务器、无构建步骤、无依赖，全部逻辑在 `edge-functions/[[default]].js`。

## 线上实例

| 项 | 值 |
|---|---|
| 访问地址 | https://proxy.labs.l.cd |
| 项目 | `edgeone-proxy`（国际站，overseas 加速区，自定义域名免备案） |
| 控制台 | https://console.tencentcloud.com/edgeone/pages/project/makers-rhrvjycgdyxt |

## 用法

下面用 `PROXY` 代指你的域名（即 `proxy.labs.l.cd`）。

### GitHub

```bash
git clone https://PROXY/gh/user/repo.git
curl -O https://PROXY/gh/user/repo/releases/download/v1.0.0/app.zip
curl https://PROXY/raw/user/repo/main/README.md
curl https://PROXY/api/repos/user/repo
```

- 路径首段支持别名：`gh` `raw` `api` `codeload` `gist` `gistraw` `assets`
- 也可以直接写域名：`/github.com/...`、`/raw.githubusercontent.com/...`
- 完整 URL 形式（仅限白名单主机）：`PROXY/https://github.com/user/repo`

Release 下载和 `codeload` 的 302 在服务端跟随，客户端只需一次请求。

### Docker Hub

`/etc/docker/daemon.json`：

```json
{
  "registry-mirrors": ["https://PROXY"]
}
```

```bash
sudo systemctl restart docker
docker pull nginx
```

原理：`/v2/...` 转发到 `registry-1.docker.io`；401 响应中指向 `auth.docker.io` 的 realm 会被重写成 `https://PROXY/token`，取票请求也走代理。

不配 mirror 也能直接用：`docker pull PROXY/library/nginx:latest`。

### 其他镜像仓库

Docker 客户端固定以 `/v2/` 开头，所以用 `/v2/<仓库别名>/...` 分流：

```bash
docker pull PROXY/ghcr/owner/image:tag
docker pull PROXY/gcr/google-containers/pause:3.9
docker pull PROXY/quay/coreos/etcd:latest
docker pull PROXY/k8s/pause:3.9
```

`ghcr`→ghcr.io、`gcr`→gcr.io、`quay`→quay.io、`k8s`→registry.k8s.io。取票路径已分别适配（gcr 用 `/v2/token`，quay 用 `/v2/auth`）。

### 支持的主机

`github.com` `api.github.com` `raw.githubusercontent.com` `codeload.github.com` `objects.githubusercontent.com` `release-assets.githubusercontent.com` `gist.github.com` `gist.githubusercontent.com` `github.githubassets.com` `media.githubusercontent.com` `uploads.github.com` `registry-1.docker.io` `index.docker.io` `auth.docker.io` `ghcr.io` `gcr.io` `quay.io` `registry.k8s.io`

白名单外一律 404，不会变成开放代理。

## 部署与更新

```bash
npm i -g edgeone
edgeone login -s global        # 国际站账号
edgeone makers deploy . -n edgeone-proxy -a overseas
```

目录结构：

```
edge-functions/[[default]].js   # 代理全部逻辑
public/index.html               # 首页使用说明（静态，优先命中 /）
edgeone.json                    # outputDirectory: ./public
```

也可以把仓库推送到 GitHub，在控制台用 Git 关联部署。

### 中国大陆访问（重要）

EdgeOne 国际站的默认域名 `*.edgeone.dev` 对**大陆 IP** 只发放 3 小时有效的预览链接，过期返回 401。绑定自定义域名后即可稳定访问，overseas 加速区无需 ICP 备案。

绑定只能在控制台操作（CLI/API 未开放）：项目 → **域名管理** → **添加自定义域名** → 按弹窗在 DNS 服务商添加 TXT 验证记录与 CNAME → 等待生效、证书签发。

## 限制

- **只为拉取设计**：请求体流式直传，但平台仍有大小限制（旧的缓冲实现实测 5.0MB 通过、5.02MB 起返回 545，流式后未重新压测），`docker push` 和较大的 `git push` 不保证可用。
- CPU 200ms（不含 I/O），大文件靠流式转发。
- 代码包上限 5MB。
- **不支持 WebSocket**：Makers 边缘函数是 request/response 模型，没有 `WebSocketPair` / upgrade 处理。需要 WS 反代请用 Cloudflare Workers，或用 EdgeOne「站点 + 源站」并打开站点的 WebSocket 开关。单向流式（SSE、大文件）不受影响。
- 不缓存内容，需要缓存请在 EdgeOne 控制台配置。

## 实现说明

- 请求统一带 `Accept-Encoding: identity`，响应删除 `Content-Encoding` / `Content-Length`，避免运行时自动解压导致编码不一致；代价是回源段不压缩。
- 响应附带 `Access-Control-Allow-Origin: *`，方便浏览器直接 fetch 下载。