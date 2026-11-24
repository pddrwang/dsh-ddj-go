/**
 * 叮咚鸡 Go Host half.
 *
 * `/ddj-go-api/*` proxies the local biomed control plane (`/api/go/*` plus the
 * dashboard read APIs) with one backend context cookie. Self-contained so the
 * package can be installed from a plugin market without extra bundles.
 */
export const name = 'dsh-ddj-go'
export const inject = []

const BACKEND = process.env.DDJ_BACKEND || 'http://127.0.0.1:19999'
const API_PREFIX = '/ddj-go-api'
const MAX_BODY = 2 * 1024 * 1024
const PROXY_TIMEOUT_MS = 15 * 60 * 1000

let contextCookie = ''

function applyContextCookie(headers) {
  if (contextCookie) headers.cookie = contextCookie
}

function captureContextCookie(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(';')[0] || ''
    if (pair.startsWith('ddj_context=')) contextCookie = pair
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function trustedRequest(req) {
  const method = String(req.method || 'GET').toUpperCase()
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false
  const origin = String(req.headers['origin'] || '')
  if (origin && origin !== 'null') {
    try {
      const parsed = new URL(origin)
      const host = String(parsed.host || '').toLowerCase()
      if (host !== String(req.headers['host'] || '').toLowerCase()) return false
    } catch {
      return false
    }
  }
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    if (String(req.headers['x-ddj-go'] || '') !== '1') return false
  }
  return true
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        const error = new Error('请求体过大')
        error.status = 413
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function handleApi(req, res, url) {
  try {
    if (!trustedRequest(req)) {
      sendJson(res, 403, { ok: false, error: '跨来源请求被拒绝' })
      return
    }
    const suffix = url.pathname.slice(API_PREFIX.length) || '/'
    if (!suffix.startsWith('/api/')) {
      sendJson(res, 403, { ok: false, error: '仅允许 /api/ 路径' })
      return
    }
    const headers = { accept: 'application/json' }
    applyContextCookie(headers)
    const contentType = req.headers['content-type']
    if (contentType) headers['content-type'] = contentType
    const method = req.method || 'GET'
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)
    const response = await fetch(`${BACKEND}${suffix}${url.search}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    })
    captureContextCookie(response)
    const buffer = Buffer.from(await response.arrayBuffer())
    res.writeHead(response.status, {
      'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(buffer)
  } catch (error) {
    if (!res.headersSent) sendJson(res, error.status || 500, { ok: false, error: error.message || String(error) })
    else res.destroy()
  }
}

import { installNative } from './lib/native.js'

export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: (req, res) => handleApi(req, res, new URL(req.url ?? '/', 'http://localhost')),
        }),
      'ddj-go.api',
    )
  })
  installNative(ctx)
}
