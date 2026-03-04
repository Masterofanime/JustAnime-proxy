export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/m3u8-proxy") {
      return handleM3U8Proxy(request, env);
    } else if (url.pathname === "/ts-proxy") {
      return handleTsProxy(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

const isOriginAllowed = (origin, env) => {
  // If no origin is provided, allow it (common for some players/direct access)
  if (!origin) return true;

  const allowedOrigins = (env.ALLOWED_ORIGINS || "*").split(",").map(o => o.trim());
  if (allowedOrigins.includes("*")) return true;
  return allowedOrigins.includes(origin);
};

async function handleM3U8Proxy(request, env) {
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get("url");
  const headers = JSON.parse(searchParams.get("headers") || "{}");
  const origin = request.headers.get("Origin") || "";

  if (!isOriginAllowed(origin, env)) {
    return new Response(`Origin "${origin}" not allowed`, {
      status: 403,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }

  if (!targetUrl) return new Response("URL required", { status: 400 });

  const finalHeaders = {
    "Referer": env.DEFAULT_REFERER || "https://megacloud.blog",
    "Origin": env.DEFAULT_ORIGIN || "https://hianime.to",
    "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    ...headers
  };

  try {
    const response = await fetch(targetUrl, { headers: finalHeaders });
    if (!response.ok) return new Response("Fetch failed", { status: response.status, headers: { "Access-Control-Allow-Origin": "*" } });

    let m3u8 = await response.text();
    const lines = m3u8.split("\n");
    const newLines = [];

    const urlObj = new URL(request.url);
    const workerUrl = `${urlObj.protocol}//${urlObj.host}`;

    // Check if this is a Master Playlist (contains stream info)
    const isMaster = m3u8.includes("#EXT-X-STREAM-INF");

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      if (line.startsWith("#")) {
        if (line.startsWith("#EXT-X-KEY:") || line.startsWith("#EXT-X-MEDIA:")) {
          const uriMatch = line.match(/URI=["']?([^"']+)["']?/);
          if (uriMatch) {
            const originalUri = uriMatch[1];
            const absoluteUri = new URL(originalUri, targetUrl).href;

            // EXT-X-MEDIA for audio/subs are often M3U8s, while KEYs are usually fragments
            const isMediaPlaylist = line.includes("TYPE=AUDIO") || line.includes("TYPE=SUBTITLES") || originalUri.includes(".m3u8");
            const proxyPath = isMediaPlaylist ? "/m3u8-proxy" : "/ts-proxy";

            const newUrl = `${workerUrl}${proxyPath}?url=${encodeURIComponent(absoluteUri)}&headers=${encodeURIComponent(JSON.stringify(headers))}`;
            newLines.push(line.replace(originalUri, newUrl));
          } else {
            newLines.push(line);
          }
        } else {
          newLines.push(line);
        }
      } else {
        const absoluteUri = new URL(line, targetUrl).href;
        // In Master Playlists, lines are variant playlists. In Media Playlists, they are segments.
        const isM3U8 = line.includes(".m3u8") || isMaster;
        const proxyPath = isM3U8 ? "/m3u8-proxy" : "/ts-proxy";

        newLines.push(`${workerUrl}${proxyPath}?url=${encodeURIComponent(absoluteUri)}&headers=${encodeURIComponent(JSON.stringify(headers))}`);
      }
    }

    return new Response(newLines.join("\n"), {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
      },
    });
  } catch (e) {
    return new Response(e.message, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
  }
}

async function handleTsProxy(request, env) {
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get("url");
  const headers = JSON.parse(searchParams.get("headers") || "{}");
  const origin = request.headers.get("Origin") || "";

  if (!isOriginAllowed(origin, env)) {
    return new Response(`Origin "${origin}" not allowed`, {
      status: 403,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }

  if (!targetUrl) return new Response("URL required", { status: 400 });

  const forwardHeaders = new Headers({
    "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Referer": env.DEFAULT_REFERER || "https://megacloud.blog",
    "Origin": env.DEFAULT_ORIGIN || "https://hianime.to",
    ...headers
  });

  if (request.headers.has("Range")) {
    forwardHeaders.set("Range", request.headers.get("Range"));
  }

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: forwardHeaders,
    });

    const responseHeaders = new Headers({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
      "Cache-Control": "public, max-age=3600"
    });

    const headersToForward = ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"];
    headersToForward.forEach(h => {
      if (response.headers.has(h)) responseHeaders.set(h, response.headers.get(h));
    });

    if (!responseHeaders.has("Content-Type")) {
      responseHeaders.set("Content-Type", targetUrl.includes(".m4s") ? "video/iso.segment" : "video/mp2t");
    }

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (e) {
    return new Response(e.message, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
  }
}
