const API_BASE = '/ddj-go-api/api'
let openChatView = () => {}
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const ROOTS = [
  { key: 'manuscript', label: '手稿', path: '结果文件/manuscript' },
  { key: 'figures', label: '图稿', path: '结果文件/figures' },
  { key: 'documents', label: '手稿文书', path: '手稿文书' },
]

function readSessionId() {
  try {
    const raw = window.localStorage.getItem('dsh.sessions.current') || ''
    const match = raw.match(UUID_RE)
    return match ? match[0] : ''
  } catch {
    return ''
  }
}

async function proxyApi(path, init) {
  const options = Object.assign({ headers: {} }, init || {})
  options.headers = Object.assign({ accept: 'application/json', 'x-ddj-go': '1' }, options.headers)
  if (options.body && typeof options.body !== 'string') {
    options.headers['content-type'] = 'application/json'
    options.body = JSON.stringify(options.body)
  }
  const response = await fetch(API_BASE + path, options)
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  if (!response.ok) {
    const message = (data && (data.error || data.message || data.detail)) || 'HTTP ' + response.status
    const error = new Error(message)
    error.status = response.status
    throw error
  }
  return data
}

function downloadUrl(filePath, inline) {
  return '/ddj-api/api/go/download?path=' + encodeURIComponent(filePath) + (inline ? '&inline=1' : '')
}

function formatSize(bytes) {
  const value = Number(bytes || 0)
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value < 1024) return value + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
  return (value / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatTime(value) {
  const date = new Date(Number(value) * 1000)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function isImage(entry) {
  return entry && (entry.image || /\.(png|jpe?g|webp|gif|svg|tiff?|bmp)$/i.test(entry.name || ''))
}

function isDocument(entry) {
  return entry && (entry.document || /\.(docx?|pdf|pptx?|xlsx?)$/i.test(entry.name || ''))
}

async function readBlob(file) {
  const response = await fetch(downloadUrl(file.path), { headers: { accept: '*/*', 'x-ddj-go': '1' } })
  if (!response.ok) throw new Error('下载失败 HTTP ' + response.status)
  const blob = await response.blob()
  return { blob, file: new File([blob], file.name, { type: blob.type || 'application/octet-stream' }) }
}

function GoIcon({ size = 20 }) {
  return h(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
    h('path', { d: 'M4 19V9.5L12 4l8 5.5V19a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1Z' }),
    h('path', { d: 'M9 13h6' }),
  )
}

function Stat({ label, value, hint, tone }) {
  return h(
    'div',
    { className: 'ddjg-stat', 'data-tone': tone || 'plain' },
    h('span', { className: 'ddjg-stat-label' }, label),
    h('b', null, value),
    hint ? h('small', null, hint) : null,
  )
}

function GoPage() {
  const [workspace, setWorkspace] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dash, setDash] = useState(null)
  const [remote, setRemote] = useState(null)
  const [tab, setTab] = useState('dashboard')
  const [roots, setRoots] = useState(ROOTS)
  const [rootKey, setRootKey] = useState('manuscript')
  const [files, setFiles] = useState({ loading: false, error: '', entries: [], path: '' })
  const [subPath, setSubPath] = useState('')
  const [toast, setToast] = useState('')
  const [preview, setPreview] = useState(null)
  const tickRef = useRef(0)

  const say = (text) => {
    setToast(text)
    window.setTimeout(() => setToast((current) => (current === text ? '' : current)), 3600)
  }

  async function syncContext() {
    const sessionId = readSessionId()
    const resolved = await proxyApi('/workspace-resolve' + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''))
    if (!resolved || !resolved.ok || !resolved.workspace) throw new Error('无法识别当前会话的工作区')
    await proxyApi('/set-context', { method: 'POST', body: { path: resolved.workspace, source: 'dashboard-refresh', sessionId: resolved.sessionId || sessionId } })
    setWorkspace(resolved.workspace)
    return resolved
  }

  async function loadDashboard() {
    const swallow = (promise) => promise.catch(() => null)
    const [pipeline, questions, conclusions, citations, conclusionAudit, figureAudit, objects, remoteStatus] = await Promise.all([
      swallow(proxyApi('/pipeline/status')),
      swallow(proxyApi('/questions')),
      swallow(proxyApi('/conclusions')),
      swallow(proxyApi('/audit/citations')),
      swallow(proxyApi('/audit/conclusions')),
      swallow(proxyApi('/audit/figures')),
      swallow(proxyApi('/v1/research/objects')),
      swallow(proxyApi('/remote/status')),
    ])
    const steps = (pipeline && pipeline.pipeline && pipeline.pipeline.steps) || []
    const done = steps.filter((step) => step.status === 'done').length
    const current = steps.find((step) => step.id === (pipeline && pipeline.pipeline && pipeline.pipeline.current_step)) || steps.find((step) => step.status === 'active' || step.status === 'current')
    const questionList = (questions && questions.questions) || []
    const pending = questionList.filter((item) => item.status !== 'resolved')
    const claims = (conclusions && conclusions.conclusions) || []
    const supported = claims.filter((item) => item.status === 'supported').length
    const citationCounts = (citations && citations.counts) || {}
    const citationIssues = (citations && (citations.coverage_issues || []).length) || 0
    const conclusionSummary = (conclusionAudit && conclusionAudit.summary) || {}
    const conclusionIssues = Number(conclusionSummary.no_evidence || 0) + Number(conclusionSummary.stale_evidence || 0) + Number(conclusionSummary.supported_unsafe || 0)
    const figureSummary = (figureAudit && figureAudit.summary) || {}
    const figureIssues = Number(figureSummary.visual_issues || 0) + Number(figureSummary.data_issues || 0)
    const objectList = (objects && objects.objects) || []
    const continuation = objectList.filter((item) => item.payload && item.payload.workflow_kind === 'continuation').length
    setDash({
      project: (pipeline && pipeline.pipeline && pipeline.pipeline.project) || (pipeline && pipeline.workspace && pipeline.workspace.split('/').pop()) || '',
      scenario: (pipeline && pipeline.pipeline && pipeline.pipeline.scenario) || '',
      steps,
      done,
      total: steps.length,
      pct: steps.length ? Math.round((done / steps.length) * 100) : 0,
      current: current || null,
      questions: questionList,
      pending,
      agreed: questionList.filter((item) => item.status === 'agreed').length,
      claims,
      supported,
      unresolved: claims.length - supported,
      continuation,
      citationCounts,
      citationIssues,
      conclusionIssues,
      figureIssues,
      auditIssues: citationIssues + conclusionIssues + figureIssues,
    })
    if (remoteStatus && remoteStatus.ok) setRemote(remoteStatus)
    return pipeline
  }

  async function loadFiles(key, relative) {
    setFiles((prev) => Object.assign({}, prev, { loading: true, error: '' }))
    try {
      const data = await proxyApi('/go/files?root=' + encodeURIComponent(key) + (relative ? '&path=' + encodeURIComponent(relative) : ''))
      if (!data || data.ok === false) throw new Error((data && (data.error || data.message)) || '目录读取失败')
      setFiles({ loading: false, error: '', entries: data.entries || [], path: data.path || '', root: data.root || null })
    } catch (fileError) {
      setFiles({ loading: false, error: String((fileError && fileError.message) || fileError), entries: [], path: '' })
    }
  }

  async function reload() {
    const ticket = ++tickRef.current
    setLoading(true)
    setError('')
    try {
      await syncContext()
      const [rootsData] = await Promise.all([
        proxyApi('/go/roots').catch(() => null),
        loadDashboard(),
      ])
      if (ticket !== tickRef.current) return
      if (rootsData && rootsData.roots) setRoots(rootsData.roots)
      await loadFiles(rootKey, subPath)
    } catch (loadError) {
      setError(String((loadError && loadError.message) || loadError))
    } finally {
      if (ticket === tickRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadDashboard().catch(() => {})
    }, 30000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (tab !== 'files') return
    setSubPath('')
    void loadFiles(rootKey, '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, rootKey])

  async function saveFile(entry) {
    try {
      const { blob } = await readBlob(entry)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = entry.name
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60000)
      say('已开始下载：' + entry.name + '（可在系统下载/通知中用 WPS 打开）')
    } catch (error) {
      say('下载失败：' + String((error && error.message) || error))
    }
  }

  async function openWithWps(entry) {
    try {
      const { file } = await readBlob(entry)
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: entry.name, text: '叮咚鸡项目文件' })
        say('已打开系统分享，请选择 WPS')
        return
      }
    } catch (error) {
      /* fall through to download */
    }
    await saveFile(entry)
    say('文件已下载，请用 WPS 打开：' + entry.name)
  }

  function previewFile(entry) {
    if (!isImage(entry)) return
    setPreview(entry)
  }

  const header = h(
    'header',
    { className: 'ddjg-head' },
    h(
      'div',
      { className: 'ddjg-head-main' },
      h('span', { className: 'ddjg-eyebrow' }, '叮咚鸡 Go'),
      h('h1', null, (dash && dash.project) || (workspace ? workspace.split('/').pop() : '当前项目')),
      h(
        'div',
        { className: 'ddjg-pills' },
        dash ? h('span', { className: 'ddjg-pill' }, dash.scenario || '未启动场景') : null,
        dash && dash.current ? h('span', { className: 'ddjg-pill ddjg-pill-on' }, dash.current.label || dash.current.id) : h('span', { className: 'ddjg-pill' }, '未启动管线'),
        remote && remote.installed ? h('span', { className: 'ddjg-pill', 'data-tone': remote.controlOnline ? 'ok' : 'muted' }, 'Remote ' + (remote.controlOnline ? '在线' : '未连接')) : null,
      ),
    ),
    h(
      'div',
      { className: 'ddjg-head-actions' },
      h('button', { type: 'button', className: 'ddjg-btn', onClick: () => openChatView() }, '对话'),
      h('button', { type: 'button', className: 'ddjg-btn', onClick: () => void reload(), disabled: loading }, loading ? '刷新中…' : '刷新'),
    ),
  )

  const stats = dash
    ? h(
        'section',
        { className: 'ddjg-stats' },
        h(Stat, { label: '科学问题', value: String(dash.pending.length) + '/' + String(dash.questions.length), hint: dash.agreed + ' 定稿 · ' + dash.pending.length + ' 待办' }),
        h(Stat, { label: '计划管线', value: dash.done + '/' + dash.total, hint: dash.current ? '当前：' + (dash.current.label || dash.current.id) : '未启动' }),
        h(Stat, { label: '结论', value: String(dash.claims.length), hint: dash.supported + ' 已支持 · ' + dash.unresolved + ' 待复核' }),
        h(Stat, { label: '审计问题', value: String(dash.auditIssues), hint: '引用 ' + dash.citationIssues + ' · 结论 ' + dash.conclusionIssues + ' · 图表 ' + dash.figureIssues, tone: dash.auditIssues ? 'warn' : 'ok' }),
      )
    : null

  const progress = dash
    ? h(
        'section',
        { className: 'ddjg-card ddjg-progress-card' },
        h('div', { className: 'ddjg-progress-top' }, h('b', null, '研究闭环进度'), h('span', null, dash.pct + '%')),
        h('div', { className: 'ddjg-track' }, h('i', { style: { width: dash.pct + '%' } })),
        h('div', { className: 'ddjg-steps' }, dash.steps.slice(0, 12).map((step) => h('span', { key: step.id, className: 'ddjg-step', 'data-state': step.status || 'idle' }, (step.status === 'done' ? '✓ ' : step.status === 'active' || step.status === 'current' ? '▶ ' : '○ ') + (step.label || step.id)))),
        dash.current && dash.current.next ? h('p', { className: 'ddjg-muted ddjg-next' }, '下一步：' + String(dash.current.next)) : null,
      )
    : null

  const questionsCard = dash && dash.pending.length
    ? h(
        'section',
        { className: 'ddjg-card' },
        h('div', { className: 'ddjg-card-title' }, h('b', null, '待办科学问题'), h('span', null, dash.pending.length + ' 项')),
        h('ul', { className: 'ddjg-list' }, dash.pending.slice(0, 5).map((item) => h('li', { key: item.id }, h('p', null, String(item.statement || item.title || item.id || '')), h('small', null, { discussing: '讨论中', agreed: '已定稿', parked: '已搁置' }[item.status] || item.status || '待开始')))),
      )
    : null

  const auditCard = dash && dash.auditIssues
    ? h(
        'section',
        { className: 'ddjg-card' },
        h('div', { className: 'ddjg-card-title' }, h('b', null, '审计提醒'), h('span', { className: 'ddjg-warn' }, dash.auditIssues + ' 项')),
        h('p', { className: 'ddjg-muted' }, '引用问题 ' + dash.citationIssues + ' · 结论问题 ' + dash.conclusionIssues + ' · 图表问题 ' + dash.figureIssues + '。审计通过不等于科学正确。'),
      )
    : null

  const remoteCard = remote && remote.installed
    ? h(
        'section',
        { className: 'ddjg-card ddjg-remote' },
        h('div', { className: 'ddjg-card-title' }, h('b', null, '远程通道'), h('span', { 'data-tone': remote.controlOnline ? 'ok' : 'muted' }, remote.controlOnline ? '在线' : '未连接')),
        h('p', { className: 'ddjg-muted' }, 'DSH Remote v' + String(remote.version || '') + (remote.inboundOnly ? ' · 仅受控' : '') + (remote.peers && remote.peers.length ? ' · 已信任 ' + remote.peers.map((peer) => peer.name || peer.platform).join('、') : '')),
      )
    : null

  const rootButtons = h(
    'div',
    { className: 'ddjg-roots' },
    roots.map((root) => h('button', { key: root.key, type: 'button', className: 'ddjg-rootbtn', 'data-active': String(root.key === rootKey), onClick: () => { setRootKey(root.key); setSubPath('') } }, root.label)),
  )

  const fileList = h(
    'section',
    { className: 'ddjg-card' },
    h('div', { className: 'ddjg-card-title' }, h('b', null, '项目文件'), h('span', null, files.entries.length + ' 项')),
    rootButtons,
    h('p', { className: 'ddjg-muted ddjg-path' }, files.path || '读取中…'),
    subPath ? h('button', { type: 'button', className: 'ddjg-link', onClick: () => { setSubPath(''); void loadFiles(rootKey, '') } }, '← 返回上级') : null,
    files.loading ? h('p', { className: 'ddjg-muted' }, '读取目录中…') : null,
    files.error ? h('p', { className: 'ddjg-warn' }, files.error) : null,
    !files.loading && !files.error && !files.entries.length ? h('p', { className: 'ddjg-muted' }, '这个目录里还没有文件。') : null,
    files.entries.length
      ? h(
          'ul',
          { className: 'ddjg-files' },
          files.entries
            .slice()
            .sort((left, right) => Number(right.dir) - Number(left.dir) || String(left.name).localeCompare(String(right.name), 'zh-Hans-CN'))
            .map((entry) => {
              const root = roots.find((item) => item.key === rootKey) || ROOTS.find((item) => item.key === rootKey) || { path: '' }
              const openDir = () => {
                if (!entry.dir) return
                const prefix = root.path ? root.path + '/' : ''
                const relative = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path
                setSubPath(relative)
                void loadFiles(rootKey, relative)
              }
              const openFile = () => {
                if (entry.dir) return openDir()
                if (isImage(entry)) return previewFile(entry)
                return void saveFile(entry)
              }
              return h(
                'li',
                { key: entry.path, 'data-dir': String(!!entry.dir), role: 'button', tabIndex: 0, onClick: openFile, onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') openFile() } },
                isImage(entry)
                  ? h('span', { className: 'ddjg-thumb' }, h('img', { src: downloadUrl(entry.path, true), alt: entry.name, loading: 'lazy' }))
                  : h('span', { className: 'ddjg-fileicon' }, entry.dir ? '📁' : isDocument(entry) ? '📄' : '📃'),
                h(
                  'div',
                  { className: 'ddjg-filemain' },
                  h('b', null, entry.name),
                  h('small', null, entry.dir ? '目录' : formatSize(entry.size) + ' · ' + formatTime(entry.mtime)),
                ),
                h(
                  'div',
                  { className: 'ddjg-fileactions', onClick: (event) => event.stopPropagation() },
                  entry.dir
                    ? h('button', { type: 'button', className: 'ddjg-link', onClick: openDir }, '进入')
                    : h(
                        React.Fragment,
                        null,
                        isImage(entry) ? h('button', { type: 'button', className: 'ddjg-link', onClick: () => previewFile(entry) }, '预览') : null,
                        h('button', { type: 'button', className: 'ddjg-link', onClick: () => void saveFile(entry) }, '下载'),
                        isDocument(entry) ? h('button', { type: 'button', className: 'ddjg-link ddjg-link-strong', onClick: () => void openWithWps(entry) }, 'WPS') : null,
                      ),
                ),
              )
            }),
        )
      : null,
  )

  const previewOverlay = preview
    ? h(
        'div',
        { className: 'ddjg-overlay', role: 'dialog', 'aria-label': preview.name, onClick: () => setPreview(null) },
        h(
          'div',
          { className: 'ddjg-viewer', onClick: (event) => event.stopPropagation() },
          h('img', { src: downloadUrl(preview.path, true), alt: preview.name }),
          h('div', { className: 'ddjg-viewer-actions' }, h('button', { type: 'button', className: 'ddjg-btn', onClick: () => void saveFile(preview) }, '下载'), h('button', { type: 'button', className: 'ddjg-btn', onClick: () => setPreview(null) }, '关闭')),
        ),
      )
    : null

  return h(
    'div',
    { className: 'ddjg-root' },
    h('style', null, STYLES),
    header,
    h(
      'div',
      { className: 'ddjg-shell' },
      h('div', { className: 'ddjg-tabs' }, h('button', { type: 'button', className: 'ddjg-tab', 'data-active': String(tab === 'dashboard'), onClick: () => setTab('dashboard') }, '仪表盘'), h('button', { type: 'button', className: 'ddjg-tab', 'data-active': String(tab === 'files'), onClick: () => setTab('files') }, '文件')),
      error ? h('p', { className: 'ddjg-warn' }, '读取失败：' + error) : null,
      tab === 'dashboard'
        ? h('div', { className: 'ddjg-page' }, stats, progress, questionsCard, auditCard, remoteCard, h('p', { className: 'ddjg-foot' }, '数据来自项目工作区与本机叮咚鸡控制面；移动端只读展示，写操作请回到对话。'))
        : h('div', { className: 'ddjg-page' }, fileList, h('p', { className: 'ddjg-foot' }, '下载使用原始文件；WPS 按钮优先调起系统分享，否则下载后用 WPS 打开。')),
      toast ? h('div', { className: 'ddjg-toast' }, toast) : null,
      previewOverlay,
    ),
  )
}

const STYLES = `
  .ddjg-root { min-height: 100%; box-sizing: border-box; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 14px; }
  .ddjg-root *, .ddjg-root *::before, .ddjg-root *::after { box-sizing: border-box; }
  .ddjg-head { position: sticky; top: 0; z-index: 5; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px 10px; background: color-mix(in srgb, var(--dsw-alias-bg-base) 92%, transparent); backdrop-filter: blur(12px); border-bottom: 1px solid var(--dsw-alias-border-l1); }
  .ddjg-head-main { min-width: 0; }
  .ddjg-eyebrow { color: var(--dsw-alias-label-secondary); font-size: 10px; letter-spacing: .08em; }
  .ddjg-head h1 { margin: 2px 0 6px; font-size: 20px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ddjg-pills { display: flex; flex-wrap: wrap; gap: 5px; }
  .ddjg-pill { padding: 2px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 10px; }
  .ddjg-pill-on { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
  .ddjg-pill[data-tone="ok"], .ddjg-card-title [data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
  .ddjg-pill[data-tone="muted"], .ddjg-card-title [data-tone="muted"] { color: var(--dsw-alias-label-secondary); }
  .ddjg-head-actions { flex: none; }
  .ddjg-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 7px 12px; cursor: pointer; }
  .ddjg-btn:disabled { opacity: .5; }
  .ddjg-shell { max-width: 720px; margin: 0 auto; padding: 10px 12px max(20px, env(safe-area-inset-bottom)); }
  .ddjg-tabs { display: flex; gap: 6px; margin: 2px 0 10px; }
  .ddjg-tab { flex: 1; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
  .ddjg-tab[data-active="true"] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
  .ddjg-page { display: flex; flex-direction: column; gap: 10px; }
  .ddjg-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .ddjg-stat { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
  .ddjg-stat-label { color: var(--dsw-alias-label-secondary); font-size: 11px; }
  .ddjg-stat b { font-size: 20px; line-height: 1.15; letter-spacing: -.01em; }
  .ddjg-stat small { color: var(--dsw-alias-label-secondary); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ddjg-stat[data-tone="warn"] b { color: var(--dsw-alias-state-warn-primary); }
  .ddjg-stat[data-tone="ok"] b { color: var(--dsw-alias-state-success-primary); }
  .ddjg-card { padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
  .ddjg-card-title { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .ddjg-card-title b { font-size: 13px; }
  .ddjg-card-title span { color: var(--dsw-alias-label-secondary); font-size: 11px; }
  .ddjg-muted { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.55; }
  .ddjg-path { margin: 4px 0 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ddjg-warn { margin: 0; color: var(--dsw-alias-state-warn-primary); font-size: 12px; line-height: 1.55; }
  .ddjg-progress-top { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
  .ddjg-track { height: 5px; margin: 7px 0 9px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
  .ddjg-track > i { display: block; height: 100%; border-radius: inherit; background: var(--dsw-alias-label-primary); transition: width .35s ease; }
  .ddjg-next { margin-top: 7px; color: var(--dsw-alias-label-primary); }
  .ddjg-steps { display: flex; flex-wrap: wrap; gap: 5px; }
  .ddjg-step { max-width: 100%; padding: 2px 7px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ddjg-step[data-state="done"] { color: var(--dsw-alias-state-success-primary); }
  .ddjg-step[data-state="active"], .ddjg-step[data-state="current"] { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
  .ddjg-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .ddjg-list li { padding: 7px 8px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
  .ddjg-list p { margin: 0 0 2px; font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
  .ddjg-list small { color: var(--dsw-alias-label-secondary); font-size: 10px; }
  .ddjg-roots { display: flex; gap: 6px; flex-wrap: wrap; }
  .ddjg-rootbtn { flex: 1; min-width: 72px; padding: 7px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; cursor: pointer; }
  .ddjg-rootbtn[data-active="true"] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
  .ddjg-files { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .ddjg-files li { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 7px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-2); }
  .ddjg-thumb { flex: none; width: 48px; height: 48px; padding: 0; overflow: hidden; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); cursor: pointer; }
  .ddjg-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .ddjg-fileicon { flex: none; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; background: var(--dsw-alias-bg-base); font-size: 17px; }
  .ddjg-filemain { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
  .ddjg-filemain b { font-size: 12px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ddjg-filemain small { color: var(--dsw-alias-label-secondary); font-size: 10px; }
  .ddjg-fileactions { flex: none; display: flex; gap: 2px; }
  .ddjg-link { padding: 4px 6px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; cursor: pointer; }
  .ddjg-link-strong { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
  .ddjg-foot { margin: 2px 2px 0; color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 1.5; }
  .ddjg-toast { position: fixed; left: 50%; bottom: calc(18px + env(safe-area-inset-bottom)); z-index: 20; max-width: min(560px, 88vw); transform: translateX(-50%); padding: 9px 14px; border-radius: 999px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); box-shadow: 0 10px 30px rgba(0, 0, 0, .28); color: var(--dsw-alias-label-primary); font-size: 12px; }
  .ddjg-overlay { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; padding: 18px; background: rgba(0, 0, 0, .66); }
  .ddjg-viewer { display: flex; flex-direction: column; gap: 10px; max-width: 100%; max-height: 100%; }
  .ddjg-viewer img { display: block; max-width: 100%; max-height: 78vh; object-fit: contain; border-radius: 10px; background: var(--dsw-alias-bg-base); }
  .ddjg-viewer-actions { display: flex; justify-content: flex-end; gap: 8px; }
  @media (max-width: 420px) { .ddjg-head { padding: 12px 12px 8px; } .ddjg-fileactions { flex-direction: column; } }
  @media (prefers-reduced-motion: reduce) { .ddjg-root *, .ddjg-root *::before, .ddjg-root *::after { animation: none !important; transition: none !important; } }
`

return {
  inject: ['slots', 'layout'],
  apply(ctx) {
    openChatView = () => {
      try {
        ctx.layout.selectPanel('conversation')
      } catch {
        /* ignore */
      }
    }
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register({ name: 'sidebar.panellist', id: 'ddj-go', order: 25, label: '叮咚鸡 Go' }, GoIcon),
    )
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'ddj-go' }, GoPage))
    ctx.effect(() => {
      let timer = null
      try {
        const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '')
        const already = window.localStorage.getItem('ddjgo.autoOpened') === '1'
        if (mobile && !already) {
          timer = window.setTimeout(() => {
            try {
              ctx.layout.selectPanel('ddj-go')
              window.localStorage.setItem('ddjgo.autoOpened', '1')
            } catch {
              /* ignore */
            }
          }, 1200)
        }
      } catch {
        /* ignore */
      }
      return () => {
        if (timer) window.clearTimeout(timer)
      }
    })
  },
}
