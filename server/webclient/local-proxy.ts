// Serves the locally-built bot client against the real hosted server's
// static assets, so the only things actually running locally are this
// proxy and your own gateway (see tasks/README.md "Running your own
// gateway against the real server"). The live game socket and the gateway
// relay are NOT handled here at all - Client.ts/GatewayConnection.ts's
// `?engine=`/`?gateway=` overrides connect those two WebSockets straight to
// their real targets from the browser. This proxy only needs to cover:
//
// 1. The HTML page itself (byte-identical to the real one - nodeid, members,
//    profanityFilter etc. are revision-pinned config, not instance data).
// 2. /bot/*.js(.map) - serve OUR locally-built, patched bundle instead of
//    the remote one, so the override logic actually exists in the client.
// 3. Everything else (/crc, /title, /config, /interface, /media, /textures,
//    /wordenc, /sounds, /ondemand.zip, /worldmap.jag, /build, favicons,
//    /market, /hiscores, ...) - plain read-only, revision-pinned game data,
//    identical locally or remotely. Proxied straight through unchanged.
//
// Usage: bun local-proxy.ts [--upstream=rs-sdk-demo.fly.dev] [--port=8899]
// Then open:
//   http://localhost:8899/bot?bot=barry&password=<PASSWORD>&engine=rs-sdk-demo.fly.dev&gateway=localhost:7780

import { join } from 'path';

const argVal = (flag: string) => process.argv.find(a => a.startsWith(flag))?.split('=')[1];
const upstream = argVal('--upstream=') || 'rs-sdk-demo.fly.dev';
const port = parseInt(argVal('--port=') || '8899', 10);
const upstreamOrigin = `https://${upstream}`;
const botOutDir = join(import.meta.dir, 'out', 'bot');

const JS_FILES = new Set(['client.js', 'client.js.map', 'mapview.js', 'mapview.js.map', 'ondemandworker.js', 'ondemandworker.js.map']);

Bun.serve({
    port,
    async fetch(req) {
        const url = new URL(req.url);

        // Our own locally-built, patched bundle - everything else game-asset
        // related is unmodified, revision-pinned data proxied from upstream.
        const match = /^\/bot\/([^/]+)$/.exec(url.pathname);
        if (match && JS_FILES.has(match[1]!)) {
            const file = Bun.file(join(botOutDir, match[1]!));
            if (await file.exists()) {
                return new Response(file, {
                    headers: { 'Content-Type': match[1]!.endsWith('.map') ? 'application/json' : 'application/javascript' }
                });
            }
        }

        // Everything else (the HTML page itself, /crc, /title, /config,
        // /interface, /media, /textures, /wordenc, /sounds, /ondemand.zip,
        // /worldmap.jag, /build, favicons, /market, /hiscores, ...) - proxy
        // straight through, unmodified.
        // Forwarding the incoming Host/Connection headers as-is onto a
        // cross-host fetch broke Bun's TLS verification against Fly.io's
        // SNI routing ("unknown certificate verification error") - a plain
        // same-method/body fetch with no inherited headers works fine, and
        // none of these are static-asset requests that need cookies/auth.
        const upstreamUrl = upstreamOrigin + url.pathname + url.search;
        const res = await fetch(upstreamUrl, {
            method: req.method,
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
        });
        // Strip encoding/length headers - fetch() already decoded the body,
        // so forwarding the original compressed-length header would lie.
        const headers = new Headers(res.headers);
        headers.delete('content-encoding');
        headers.delete('content-length');
        return new Response(res.body, { status: res.status, headers });
    },
});

console.log(`[local-proxy] Serving the patched bot client on http://localhost:${port}, proxying game assets from ${upstreamOrigin}`);
console.log(`[local-proxy] Open: http://localhost:${port}/bot?bot=<name>&password=<PASSWORD>&engine=${upstream}&gateway=localhost:7780`);
