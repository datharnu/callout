// Local stand-in for the hosted layout (docs/HOSTED.md), for previews only:
//   /            → web/dist          /try/ → web/dist/try/
//   /glasses/    → glasses/dist      /media/ → docs/media
//   /api/*       → proxied to the local backend (default http://127.0.0.1:8787)
// Usage: node web/scripts/serve-local.mjs [port]
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, request } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = Number(process.argv[2] ?? 5190)
const API = new URL(process.env.CALLOUT_API ?? 'http://127.0.0.1:8787')
const MOUNTS = [
  ['/glasses/', path.join(root, 'glasses', 'dist')],
  ['/media/', path.join(root, 'docs', 'media')],
  ['/', path.join(root, 'web', 'dist')],
]
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.json': 'application/json' }

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname.startsWith('/api/')) {
    const up = request({ host: API.hostname, port: API.port, path: req.url, method: req.method, headers: { ...req.headers, host: API.host } }, r => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on('error', () => { res.writeHead(502); res.end('backend unreachable') })
    req.pipe(up)
    return
  }
  if (url.pathname === '/try' || url.pathname === '/glasses') { res.writeHead(301, { location: url.pathname + '/' + url.search }); res.end(); return }
  for (const [prefix, dir] of MOUNTS) {
    if (!url.pathname.startsWith(prefix)) continue
    let file = path.join(dir, decodeURIComponent(url.pathname.slice(prefix.length)))
    if (!file.startsWith(dir)) break
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!existsSync(file)) break
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
    return
  }
  res.writeHead(404); res.end('not found')
}).listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${PORT}  (api → ${API.origin})`))
