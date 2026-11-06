// EdgeOne Pages 边缘函数：GitHub / Docker 镜像代理
// 路由按路径首段分发，不在白名单内的一律拒绝（避免变成开放代理）

const ALIASES = {
  gh: 'github.com',
  raw: 'raw.githubusercontent.com',
  api: 'api.github.com',
  codeload: 'codeload.github.com',
  gist: 'gist.github.com',
  gistraw: 'gist.githubusercontent.com',
  assets: 'github.githubassets.com',
  ghcr: 'ghcr.io',
  gcr: 'gcr.io',
  quay: 'quay.io',
  k8s: 'registry.k8s.io',
};

// 允许直接把域名当作第一段使用的主机
const HOST_PREFIXED = new Set([
  ...Object.values(ALIASES),
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'uploads.github.com',
  'media.githubusercontent.com',
  'registry-1.docker.io',
  'index.docker.io',
  'auth.docker.io',
]);

// 可用 /v2/<别名>/... 访问的镜像仓库（docker 客户端总是以 /v2/ 开头）
const REGISTRY_ALIASES = new Set(['ghcr', 'gcr', 'quay', 'k8s']);

// 部分仓库的 token 路径不在 /token
const TOKEN_PATHS = {
  'gcr.io': '/v2/token',
  'quay.io': '/v2/auth',
};

// 401 挑战里的 realm 换成代理自己的 token 入口
const REALM_ROUTES = {
  'auth.docker.io': '/token',
  'ghcr.io': '/ghcr/token',
  'gcr.io': '/gcr/token',
  'quay.io': '/quay/token',
};

const SKIP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'accept-encoding', 'content-length',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
  'x-client-ip', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry',
]);

const SKIP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
  'content-encoding', 'content-length',
  'content-security-policy', 'content-security-policy-report-only',
]);

const CORS_EXPOSE = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': '*',
};

// /any/ 只允许公网 http(s)，挡掉回环、内网、链路本地和云元数据地址
function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') {
    return true;
  }

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateHost(mapped[1]);
  }

  return false;
}

function resolveRoute(pathname, search = '') {
  if (/^\/https?:\/\//i.test(pathname)) {
    let target;
    try {
      target = new URL(pathname.slice(1));
    } catch {
      return null;
    }
    if (!HOST_PREFIXED.has(target.hostname)) return null;
    return { host: target.hostname, path: target.pathname || '/' };
  }

  const firstEnd = pathname.indexOf('/', 1);
  const first = (firstEnd === -1 ? pathname.slice(1) : pathname.slice(1, firstEnd)).toLowerCase();
  if (!first) return null;
  const rest = firstEnd === -1 ? '/' : pathname.slice(firstEnd);

  // /any/<完整URL>：隐藏的开放代理，header / body 原样透传
  if (first === 'any') {
    let target;
    try {
      target = new URL(rest.slice(1) + search);
    } catch {
      return null;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    if (isPrivateHost(target.hostname)) return null;
    return {
      host: target.hostname,
      path: target.pathname || '/',
      search: target.search,
      protocol: target.protocol,
    };
  }

  if (first === 'token') {
    return { host: 'auth.docker.io', path: '/token' };
  }

  // Docker Hub 镜像模式：/v2/... 直接透传；/v2/<别名>/... 分流到其他仓库
  if (first === 'v2') {
    const afterV2 = rest.slice(1);
    const slash = afterV2.indexOf('/');
    const segment = (slash === -1 ? afterV2 : afterV2.slice(0, slash)).toLowerCase();
    const remainder = slash === -1 ? '/' : afterV2.slice(slash);
    if (REGISTRY_ALIASES.has(segment)) {
      return { host: ALIASES[segment], path: '/v2' + remainder };
    }
    return { host: 'registry-1.docker.io', path: '/v2' + rest };
  }

  const host = ALIASES[first] || (HOST_PREFIXED.has(first) ? first : null);
  if (!host) return null;
  return { host, path: rest === '/token' && TOKEN_PATHS[host] ? TOKEN_PATHS[host] : rest };
}

function usagePage(url) {
  const origin = url.origin;
  const text = [
    'EdgeOne GitHub / Docker 代理',
    '',
    'GitHub:',
    `  git clone ${origin}/gh/user/repo.git`,
    `  ${origin}/raw/user/repo/main/file.js`,
    `  ${origin}/gh/user/repo/releases/download/v1.0.0/app.zip`,
    `  ${origin}/api/repos/user/repo`,
    '',
    'Docker Hub（daemon.json 里 registry-mirrors 填本域名）:',
    `  docker pull ${origin.replace(/^https?:\/\//, '')}/library/nginx:latest`,
    '',
    '其他镜像仓库:',
    `  docker pull ${origin.replace(/^https?:\/\//, '')}/ghcr/owner/image:tag`,
    `  docker pull ${origin.replace(/^https?:\/\//, '')}/gcr|quay|k8s/<repo>`,
    '',
    '支持的主机：',
    `  ${[...HOST_PREFIXED].join('  ')}`,
    `  别名：${Object.keys(ALIASES).join(' ')}`,
    '',
    '限制：请求体上限 1MB，只支持拉取，不支持 docker push。',
  ].join('\n');

  return new Response(text, {
    status: 404,
    headers: { ...CORS_EXPOSE, 'content-type': 'text/plain; charset=utf-8' },
  });
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS_EXPOSE,
        'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': request.headers.get('access-control-request-headers') || '*',
        'access-control-max-age': '86400',
      },
    });
  }

  const route = resolveRoute(url.pathname, url.search);
  if (!route) return usagePage(url);

  const target = new URL(`${route.protocol || 'https:'}//${route.host}${route.path}`);
  target.search = route.search ?? url.search;

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (!SKIP_REQUEST_HEADERS.has(key)) headers.set(key, value);
  }
  // 让上游返回未压缩内容，否则响应体可能与声明的编码不一致
  headers.set('accept-encoding', 'identity');

  const init = {
    method: request.method,
    headers,
    redirect: 'follow',
  };
  // 请求体流式直传，避免整包读进内存后再转发
  if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (error) {
    return new Response(`上游请求失败：${target.href}\n${error.message}`, {
      status: 502,
      headers: { ...CORS_EXPOSE, 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const responseHeaders = new Headers(upstream.headers);
  for (const key of SKIP_RESPONSE_HEADERS) responseHeaders.delete(key);
  responseHeaders.set('access-control-allow-origin', '*');
  responseHeaders.set('access-control-expose-headers', '*');

  const challenge = responseHeaders.get('www-authenticate');
  if (challenge) {
    responseHeaders.set(
      'www-authenticate',
      challenge.replace(/realm="([^"]+)"/, (match, realm) => {
        try {
          const path = REALM_ROUTES[new URL(realm).hostname];
          return path ? `realm="${url.origin}${path}"` : match;
        } catch {
          return match;
        }
      }),
    );
  }

  const noBody = request.method === 'HEAD' || upstream.status === 204 || upstream.status === 304;
  return new Response(noBody ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}