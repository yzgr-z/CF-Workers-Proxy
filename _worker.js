var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// _worker.js

function logError(request, message) {
  console.error(
    `${message}, clientIp: ${request.headers.get("cf-connecting-ip")}, user-agent: ${request.headers.get("user-agent")}, url: ${request.url}`
  );
}
__name(logError, "logError");

function createNewRequest(request, url, proxyHostname, originHostname) {
  const newRequestHeaders = new Headers(request.headers);
  for (const [key, value] of newRequestHeaders) {
    if (value.includes(originHostname)) {
      newRequestHeaders.set(
        key,
        value.replace(
          new RegExp(`(?<!\\.)\\b${originHostname}\\b`, "g"),
          proxyHostname
        )
      );
    }
  }
  return new Request(url.toString(), {
    method: request.method,
    headers: newRequestHeaders,
    body: request.body,
    redirect: "follow"
  });
}
__name(createNewRequest, "createNewRequest");

function setResponseHeaders(originalResponse, proxyHostname, originHostname, DEBUG) {
  const newResponseHeaders = new Headers(originalResponse.headers);
  for (const [key, value] of newResponseHeaders) {
    if (value.includes(proxyHostname)) {
      newResponseHeaders.set(
        key,
        value.replace(
          new RegExp(`(?<!\\.)\\b${proxyHostname}\\b`, "g"),
          originHostname
        )
      );
    }
  }
  if (DEBUG) {
    newResponseHeaders.delete("content-security-policy");
  }
  return newResponseHeaders;
}
__name(setResponseHeaders, "setResponseHeaders");

async function replaceResponseText(originalResponse, proxyHostname, pathnameRegex, originHostname) {
  let text = await originalResponse.text();
  if (pathnameRegex) {
    pathnameRegex = pathnameRegex.replace(/^\^/, "");
    return text.replace(
      new RegExp(`((?<!\\.)\\b${proxyHostname}\\b)(${pathnameRegex})`, "g"),
      `${originHostname}$2`
    );
  } else {
    return text.replace(
      new RegExp(`(?<!\\.)\\b${proxyHostname}\\b`, "g"),
      originHostname
    );
  }
}
__name(replaceResponseText, "replaceResponseText");

// --- 新增部分开始 ---

// 1. 定义你的首页 HTML
function getWelcomePage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>我的代理服务</title>
    <style>
        body { font-family: sans-serif; text-align: center; padding-top: 50px; background: #f4f4f4; }
        .container { background: white; padding: 40px; border-radius: 8px; display: inline-block; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #333; }
        a { color: #007bff; text-decoration: none; font-size: 18px; margin: 10px; display: block;}
        a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="container">
        <h1>欢迎访问我的私有代理站</h1>
        <p>这是一个安全测试与工具站点。</p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
        <!-- 这里配置你的代理入口 -->
        <a href="/github/">🚀 进入 GitHub 加速通道</a>
        <a href="/test/">🧪 测试页面</a>
    </div>
</body>
</html>`;
}

// --- 新增部分结束 ---

var worker_default = {
  async fetch(request, env, ctx) {
    try {
      const {
        PROXY_HOSTNAME,
        PROXY_PROTOCOL = "https",
        PATHNAME_REGEX, // 建议设置为 ^/github/.* 或留空并在下面代码控制
        UA_WHITELIST_REGEX,
        UA_BLACKLIST_REGEX,
        URL302,
        IP_WHITELIST_REGEX,
        IP_BLACKLIST_REGEX,
        REGION_WHITELIST_REGEX,
        REGION_BLACKLIST_REGEX,
        KEEP_PATH = false,
        DEBUG = false
      } = env;

      const url = new URL(request.url);
      const originHostname = url.hostname;

      // --- 核心修改逻辑开始 ---

      // 1. 如果访问的是根目录 / ，直接返回欢迎页，不进行任何代理或拦截检查
      if (url.pathname === '/') {
        return new Response(getWelcomePage(), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          status: 200
        });
      }

      // 2. 如果你希望强制要求必须带前缀才能访问（例如必须以 /github/ 开头）
      // 取消下面注释并修改正则即可。目前为了兼容你的 /test，暂时不强制开启。
      /*
      if (!/^\/(github|test)\//.test(url.pathname)) {
         return new Response('Not Found', { status: 404 });
      }
      */

      // --- 核心修改逻辑结束 ---


      // 原有的校验逻辑（IP、UA、区域等）
      // 注意：现在只有非根目录的请求才会走到这里
      if (
        !PROXY_HOSTNAME ||
        (PATHNAME_REGEX && !new RegExp(PATHNAME_REGEX).test(url.pathname)) ||
        (UA_WHITELIST_REGEX && !new RegExp(UA_WHITELIST_REGEX).test(request.headers.get("user-agent").toLowerCase())) ||
        (UA_BLACKLIST_REGEX && new RegExp(UA_BLACKLIST_REGEX).test(request.headers.get("user-agent").toLowerCase())) ||
        (IP_WHITELIST_REGEX && !new RegExp(IP_WHITELIST_REGEX).test(request.headers.get("cf-connecting-ip"))) ||
        (IP_BLACKLIST_REGEX && new RegExp(IP_BLACKLIST_REGEX).test(request.headers.get("cf-connecting-ip"))) ||
        (REGION_WHITELIST_REGEX && !new RegExp(REGION_WHITELIST_REGEX).test(request.headers.get("cf-ipcountry"))) ||
        (REGION_BLACKLIST_REGEX && new RegExp(REGION_BLACKLIST_REGEX).test(request.headers.get("cf-ipcountry")))
      ) {
        logError(request, "Invalid Access");
        return URL302 ? Response.redirect(
            KEEP_PATH ? (URL302 + "/" + url.pathname).replace(/\/+/g, "/") : URL302,
            302
          ) : new Response(await nginx(), {
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
      }

      // 执行代理逻辑
      url.host = PROXY_HOSTNAME;
      url.protocol = PROXY_PROTOCOL;

      const newRequest = createNewRequest(request, url, PROXY_HOSTNAME, originHostname);
      const originalResponse = await fetch(newRequest);

      const newResponseHeaders = setResponseHeaders(originalResponse, PROXY_HOSTNAME, originHostname, DEBUG);

      const contentType = newResponseHeaders.get("content-type") || "";
      let body;

      if (contentType.includes("text/")) {
        body = await replaceResponseText(originalResponse, PROXY_HOSTNAME, PATHNAME_REGEX, originHostname);
      } else {
        body = originalResponse.body;
      }

      return new Response(body, {
        status: originalResponse.status,
        headers: newResponseHeaders
      });

    } catch (error) {
      logError(request, `Fetch error: ${error.message}`);
      return new Response("Internal Server Error", { status: 500 });
    }
  }
};

export { worker_default as default };
