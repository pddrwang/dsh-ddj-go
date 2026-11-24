// dsh-go 原生界面：面板（仪表盘 / 文件）、输入框胶囊、状态条。
// 所有数据都在主机引擎的工作区里读取；不依赖本机 biomed 后端。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const ASSET_ROOT = join(PACKAGE_ROOT, 'assets')
const PREVIEW_DIR = join(ASSET_ROOT, 'preview')

const ROOTS = [
  { key: 'manuscript', zh: '手稿', en: 'Manuscript', dir: '结果文件/manuscript' },
  { key: 'figures', zh: '图稿', en: 'Figures', dir: '结果文件/figures' },
  { key: 'documents', zh: '手稿文书', en: 'Documents', dir: '手稿文书' },
]

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const LIST_LIMIT = 60

const zh = (caps) => !/^en/i.test(String(caps?.locale ?? ''))
const rootOf = (env = process.env) => {
  if (env.DSH_WORKSPACE_ROOT) return resolve(env.DSH_WORKSPACE_ROOT)
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  try {
    const registry = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
    const id = registry?.global?.workspaceIds?.[0]
    const value = id ? registry?.tables?.workspaces?.[id]?.path : undefined
    if (typeof value === 'string' && existsSync(value)) return value
  } catch {
    /* fall through */
  }
  return process.cwd()
}

const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

const inside = (root, target) => target === root || target.startsWith(root + sep)

function resolveWithin(root, rel) {
  const candidate = resolve(root, rel || '.')
  return inside(root, candidate) ? candidate : undefined
}

function projectData(root) {
  const pipeline = readJson(join(root, '工程文件', '00_pipeline_state.json'), {}) || {}
  const conclusions = readJson(join(root, '工程文件', '.ddj_conclusions.json'), {}) || {}
  const citations = readJson(join(root, '工程文件', 'citation_verification.json'), {}) || {}
  const steps = Array.isArray(pipeline.steps) ? pipeline.steps : []
  const done = steps.filter((step) => step.status === 'done').length
  const current = steps.find((step) => step.id === pipeline.current_step) || steps.find((step) => step.status === 'active' || step.status === 'current')
  const claims = Array.isArray(conclusions.conclusions) ? conclusions.conclusions : []
  const supported = claims.filter((claim) => claim.status === 'supported').length
  const counts = citations.counts || {}
  const citationIssues = Number(counts.conflict || 0) + Number(counts.not_found || 0) + Number(counts.needs_review || 0)
  return {
    project: String(pipeline.project || basename(root) || '项目'),
    scenario: String(pipeline.scenario || ''),
    steps,
    done,
    total: steps.length,
    pct: steps.length ? Math.round((done / steps.length) * 100) : 0,
    current: current || null,
    conclusions: claims.length,
    supported,
    citationIssues,
    updated: String(pipeline.updated || ''),
  }
}

function formatSize(bytes) {
  const value = Number(bytes || 0)
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value < 1024) return value + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
  return (value / (1024 * 1024)).toFixed(1) + ' MB'
}

function listDir(root, dir) {
  const target = resolveWithin(root, dir)
  if (!target || !existsSync(target)) return { error: 'missing', entries: [] }
  let children
  try {
    children = readdirSync(target, { withFileTypes: true })
  } catch {
    return { error: 'denied', entries: [] }
  }
  const entries = []
  for (const child of children) {
    if (child.name.startsWith('.')) continue
    const abs = join(target, child.name)
    let info
    try {
      info = statSync(abs)
    } catch {
      continue
    }
    const ext = extname(child.name).toLowerCase()
    entries.push({
      name: child.name,
      rel: relative(root, abs).replaceAll(sep, '/'),
      dir: child.isDirectory(),
      image: !child.isDirectory() && IMAGE_EXT.has(ext),
      document: !child.isDirectory() && ['.docx', '.doc', '.pdf', '.pptx', '.xlsx'].includes(ext),
      size: info.size,
      mtime: info.mtimeMs,
    })
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'zh-Hans-CN'))
  return { entries: entries.slice(0, LIST_LIMIT), total: entries.length }
}

let previewCounter = 0
function previewAsset(abs, name) {
  try {
    mkdirSync(PREVIEW_DIR, { recursive: true })
    const stamp = Math.floor(statSync(abs).mtimeMs).toString(36)
    const safe = basename(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) || 'image'
    const target = join(PREVIEW_DIR, `${stamp}-${previewCounter++ % 1000}-${safe}`)
    if (!existsSync(target)) copyFileSync(abs, target)
    return 'asset:preview/' + basename(target)
  } catch {
    return undefined
  }
}

export function installNative(ctx) {
  ctx.inject(['dshGo'], (dshGoCtx) => {
    const root = rootOf()
    const states = new Map()
    const stateOf = (scope) => {
      const key = String(scope?.sessionId || 'default')
      let state = states.get(key)
      if (!state) {
        state = { rootKey: 'manuscript', dir: ROOTS[0].dir }
        if (states.size > 200) states.delete(states.keys().next().value)
        states.set(key, state)
      }
      return state
    }

    const rootByKey = (key) => ROOTS.find((item) => item.key === key) || ROOTS[0]
    const rootActions = {}
    for (const item of ROOTS) {
      rootActions['root:' + item.key] = (scope) => {
        const state = stateOf(scope)
        state.rootKey = item.key
        state.dir = item.dir
        return { refresh: true }
      }
    }

    dshGoCtx.dshGo.panel('dashboard', {
      view: (scope, caps) => {
        const data = projectData(root)
        const txt = zh(caps)
        const children = [
          { type: 'text', text: data.project + (data.scenario ? ' · ' + data.scenario : '') },
          {
            type: 'row',
            children: [
              { type: 'metric', label: txt ? '管线' : 'Pipeline', value: `${data.done}/${data.total}` },
              { type: 'metric', label: txt ? '结论' : 'Conclusions', value: String(data.conclusions), caption: `${data.supported} ${txt ? '已支持' : 'supported'}` },
              { type: 'metric', label: txt ? '引用问题' : 'Citation issues', value: String(data.citationIssues), tone: data.citationIssues ? 'warn' : 'good' },
            ],
          },
          { type: 'progress', value: data.pct, label: txt ? '研究闭环进度' : 'Loop progress', caption: `${data.pct}%` },
        ]
        if (data.steps.length) {
          children.push({
            type: 'steps',
            items: data.steps.slice(0, 12).map((step) => ({
              label: step.label || step.id,
              status: step.status === 'done' ? 'done' : step.status === 'active' || step.status === 'current' ? 'current' : 'todo',
              detail: step.module,
            })),
          })
        }
        children.push({
          type: 'callout',
          tone: 'info',
          text: txt ? '手机原生面板只读；文件下载、WPS 与完整仪表盘请使用 dsh-Go 网页版。' : 'Native panel is read-only. Use the dsh-Go web view for downloads, WPS and the full dashboard.',
        })
        children.push({ type: 'actions', items: [{ label: txt ? '刷新' : 'Refresh', action: 'refresh', style: 'plain' }] })
        return { type: 'stack', title: '叮咚鸡 Go', children }
      },
      actions: {
        refresh: () => ({ refresh: true }),
      },
    })

    dshGoCtx.dshGo.panel('files', {
      view: (scope, caps) => {
        const txt = zh(caps)
        const state = stateOf(scope)
        const rootInfo = rootByKey(state.rootKey)
        const listing = listDir(root, state.dir)
        const children = [
          { type: 'text', text: rootInfo.zh + ' / ' + (state.dir === rootInfo.dir ? '' : state.dir.slice(rootInfo.dir.length + 1)) },
          {
            type: 'actions',
            items: ROOTS.map((item) => ({ label: item.zh, action: 'root:' + item.key, style: item.key === state.rootKey ? 'primary' : 'plain' })),
          },
        ]
        if (state.dir !== rootInfo.dir) children.push({ type: 'actions', items: [{ label: txt ? '返回上级' : 'Up', action: 'up' }] })
        if (listing.error) {
          children.push({ type: 'callout', tone: 'warn', text: txt ? '这个目录不可读。' : 'This folder cannot be read.' })
          return { type: 'stack', title: '叮咚鸡 Go · 文件', children }
        }
        const images = listing.entries.filter((entry) => entry.image)
        const canGallery = Array.isArray(caps?.components) && caps.components.includes('gallery')
        if (images.length && canGallery) {
          const gallery = images.slice(0, 12).map((entry) => ({
            src: previewAsset(join(root, entry.rel), entry.name),
            alt: entry.name,
            caption: entry.name,
          })).filter((item) => item.src)
          if (gallery.length) {
            children.push({ type: 'text', text: txt ? `图片 · ${gallery.length} 张（点开可保存/分享）` : `${gallery.length} images (tap to save/share)` })
            children.push({ type: 'gallery', columns: 2, aspect: 1, items: gallery })
          }
        }
        const rest = listing.entries.filter((entry) => !entry.image)
        if (rest.length) {
          children.push({
            type: 'list',
            items: rest.map((entry) => ({
              title: entry.name,
              subtitle: entry.dir ? (txt ? '文件夹' : 'folder') : formatSize(entry.size),
              icon: entry.dir ? 'folder' : entry.document ? 'document' : 'text',
              action: { id: entry.dir ? 'enter' : 'copy', args: { path: entry.rel } },
            })),
          })
        }
        if (!listing.entries.length) children.push({ type: 'text', text: txt ? '这个目录里还没有文件。' : 'This folder is empty.' })
        children.push({
          type: 'callout',
          tone: 'info',
          text: txt ? '原生面板只能浏览和复制路径；下载或 WPS 请切到 dsh-Go 网页版。' : 'Native panel browses and copies paths only. Use the dsh-Go web view to download or open with WPS.',
        })
        children.push({ type: 'actions', items: [{ label: txt ? '刷新' : 'Refresh', action: 'refresh', style: 'plain' }] })
        return { type: 'stack', title: '叮咚鸡 Go · 文件', children }
      },
      actions: {
        refresh: (scope) => {
          const state = stateOf(scope)
          state.dir = rootByKey(state.rootKey).dir
          return { refresh: true }
        },
        up: (scope) => {
          const state = stateOf(scope)
          const base = rootByKey(state.rootKey).dir
          if (state.dir !== base) {
            const parts = state.dir.split('/')
            parts.pop()
            state.dir = parts.join('/') || base
          }
          return { refresh: true }
        },
        enter: (scope, event) => {
          const state = stateOf(scope)
          const value = typeof event?.value?.path === 'string' ? event.value.path : ''
          const target = resolveWithin(root, value)
          if (!target) return { toast: '路径不在工作区' }
          try {
            if (!statSync(target).isDirectory()) return { toast: '不是目录' }
          } catch {
            return { toast: '目录不存在' }
          }
          state.dir = value
          return { refresh: true }
        },
        copy: (scope, event) => {
          const value = typeof event?.value?.path === 'string' ? event.value.path : ''
          if (!value) return { toast: '没有路径' }
          return { copy: value, toast: '已复制相对路径' }
        },
        ...rootActions,
      },
    })

    dshGoCtx.dshGo.strip('status', (scope, emit) => {
      const push = () => {
        const data = projectData(root)
        const text = data.current ? `${data.project} · ${data.done}/${data.total} · ${data.current.label || data.current.id}` : `${data.project} · ${data.done}/${data.total}`
        emit({ text: text.slice(0, 24), icon: 'chart', tone: data.pct >= 100 ? 'good' : 'info' })
      }
      push()
      const timer = setInterval(push, 30_000)
      return () => clearInterval(timer)
    })
  })
}
