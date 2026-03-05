export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (url.pathname === "/m3u8-proxy") {
      return handleM3U8Proxy(request, env);
    } else if (url.pathname === "/ts-proxy") {
      return handleTsProxy(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

// Robust parameter extraction that handles nested URLs with '&'
function getParam(url, name) {
  const startIdx = url.indexOf(name + "=");
  if (startIdx === -1) return null;
  const valueStart = startIdx + name.length + 1;
  const nextParamIdx = url.indexOf("&headers=", valueStart);
  let value;
  if (name === "url" && nextParamIdx !== -1) {
    value = url.substring(valueStart, nextParamIdx);
  } else {
    const endIdx = url.indexOf("&", valueStart);
    value = url.substring(valueStart, endIdx === -1 ? undefined : endIdx);
  }
  return decodeURIComponent(value);
}

const isOriginAllowed = (origin, env) => {
  if (!origin) return true;
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map(o => o.trim());
  return allowed.includes("*") || allowed.includes(origin);
};

async function handleM3U8Proxy(request, env) {
  const targetUrl = getParam(request.url, "url");
  const headersParam = getParam(request.url, "headers");

  if (!targetUrl) return new Response("URL required", { status: 400 });

  // MINIMALIST PLAYER HEADERS: Mimics exactly what HLS.js or safari sends
  const fetchHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.132 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://megacloud.blog",
    "Accept-Encoding": "identity", // Disable compression to avoid parsing issues
  };

  try {
    const response = await fetch(targetUrl, { headers: fetchHeaders, redirect: "follow" });
    const finalTargetUrl = response.url || targetUrl;
    const contentType = response.headers.get("Content-Type") || "";

    const m3u8 = await response.text();
    const debugPeek = m3u8.substring(0, 100).replace(/\r?\n/g, " ");

    if (contentType.includes("text/html") || !m3u8.trim().startsWith("#EXTM3U")) {
      return new Response(m3u8, {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          "Access-Control-Allow-Origin": "*",
          "x-debug-block": "TRUE",
          "x-debug-peek-len": m3u8.length.toString(),
          "x-debug-peek": debugPeek || "EMPTY_BODY",
          "x-upstream-type": contentType,
          "x-target-url-truncated": targetUrl.includes("&") ? "FALSE" : "MAYBE"
        }
      });
    }

    const workerUrl = new URL(request.url);
    const workerBaseUrl = `${workerUrl.protocol}//${workerUrl.host}`;
    const lines = m3u8.split(/\r?\n/);
    const newLines = [];
    const isMaster = m3u8.includes("#EXT-X-STREAM-INF") || m3u8.includes("RESOLUTION=");

    for (let line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        newLines.push(line);
        continue;
      }

      if (trimmedLine.startsWith("#")) {
        if (trimmedLine.startsWith("#EXT-X-KEY:") || trimmedLine.startsWith("#EXT-X-MEDIA:")) {
          const newLine = line.replace(/URI=["']?([^"'\s,]+)["']?/, (match, originalUri) => {
            const absoluteUri = new URL(originalUri, finalTargetUrl).href;
            const isPlaylist = line.includes("TYPE=AUDIO") || line.includes("TYPE=SUBTITLES") || originalUri.includes(".m3u8");
            const proxyPath = isPlaylist ? "/m3u8-proxy" : "/ts-proxy";
            return match.replace(originalUri, `${workerBaseUrl}${proxyPath}?url=${encodeURIComponent(absoluteUri)}${headersParam ? `&headers=${encodeURIComponent(headersParam)}` : ""}`);
          });
          newLines.push(newLine);
        } else {
          newLines.push(line);
        }
      } else {
        const absoluteUri = new URL(trimmedLine, finalTargetUrl).href;
        const proxyPath = isMaster ? "/m3u8-proxy" : "/ts-proxy";
        newLines.push(`${workerBaseUrl}${proxyPath}?url=${encodeURIComponent(absoluteUri)}${headersParam ? `&headers=${encodeURIComponent(headersParam)}` : ""}`);
      }
    }

    return new Response(newLines.join("\n"), {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
    });
  } catch (e) {
    return new Response(e.message, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
  }
}

async function handleTsProxy(request, env) {
  const targetUrl = getParam(request.url, "url");
  const headersParam = getParam(request.url, "headers");
  let headers = {};
  try {
    headers = JSON.parse(headersParam || "{}");
  } catch (e) { }

  if (!targetUrl) return new Response("URL required", { status: 400 });

  const fetchHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.132 Safari/537.36",
    "Referer": "https://megacloud.blog",
    "Accept": "*/*",
  };

  const range = request.headers.get("Range") || headers["Range"];
  if (range) fetchHeaders["Range"] = range;

  try {
    const response = await fetch(targetUrl, { headers: fetchHeaders, redirect: "follow" });
    const contentType = response.headers.get("Content-Type") || "";

    if (contentType.includes("text/html")) {
      return new Response("Blocked by Upstream (HTML returned for Video Segment)", {
        status: 403,
        headers: { "Access-Control-Allow-Origin": "*", "x-debug-block": "TRUE" }
      });
    }

    const responseHeaders = new Headers({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
    });

    ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"].forEach(h => {
      if (response.headers.has(h)) responseHeaders.set(h, response.headers.get(h));
    });

    if (targetUrl.includes(".m3u8")) responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
    else if (targetUrl.includes(".ts")) responseHeaders.set("Content-Type", "video/mp2t");
    else if (targetUrl.includes(".m4s")) responseHeaders.set("Content-Type", "video/iso.segment");
    else if (targetUrl.toLowerCase().includes("key")) responseHeaders.set("Content-Type", "application/octet-stream");

    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch (e) {
    return new Response(e.message, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
  }
}
