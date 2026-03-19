export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const target = url.searchParams.get("url");
    if (!target) {
      return new Response("Missing ?url=", { status: 400 });
    }

    // ✅ Allowed origins
    const allowedOrigins = env.ALLOWED_ORIGINS
      ? env.ALLOWED_ORIGINS.split(",")
      : [];

    const requestOrigin = request.headers.get("origin");

    if (
      allowedOrigins.length &&
      requestOrigin &&
      !allowedOrigins.includes(requestOrigin)
    ) {
      return new Response("Origin not allowed", { status: 403 });
    }

    try {
      // Clone headers
      const headers = new Headers(request.headers);

      // Remove unwanted headers
      [
        "cookie",
        "cookie2",
        "x-request-start",
        "x-request-id",
        "via",
        "connect-time",
        "total-route-time",
      ].forEach((h) => headers.delete(h));

      // Add defaults
      headers.set("Referer", env.DEFAULT_REFERER);
      headers.set("Origin", env.DEFAULT_ORIGIN);

      // Fetch target
      const res = await fetch(target, {
        method: request.method,
        headers,
        body:
          request.method !== "GET" && request.method !== "HEAD"
            ? request.body
            : undefined,
      });

      const responseHeaders = new Headers(res.headers);

      // CORS
      responseHeaders.set(
        "Access-Control-Allow-Origin",
        requestOrigin || "*"
      );
      responseHeaders.set("Access-Control-Allow-Credentials", "true");

      return new Response(res.body, {
        status: res.status,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response("Proxy Error: " + err.message, { status: 500 });
    }
  },
};