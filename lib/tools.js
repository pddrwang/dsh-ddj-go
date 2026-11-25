// 原生工具卡：工具结果会写进对话记录，dsh-Go App 用原生卡片渲染。
// 这条路径**不需要 dsh-go bridge**，DSH Remote 连接也能显示，因此是手机原生界面的主入口。
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ROOTS, listDir, projectData, rootOf } from './native.js'

const CARD_MAX_BYTES = 8 * 1024

function toolCard(build) {
  return (args, value) => {
    try {
      const text = JSON.stringify(build(args, value))
      if (text === undefined || Buffer.byteLength(text, 'utf8') > CARD_MAX_BYTES) return {}
      return { 'dsh-go/view': JSON.parse(text) }
    } catch {
      return {}
    }
  }
}

function workspaceOf(value) {
  if (typeof value === 'string' && value.trim()) {
    const candidate = resolve(value.trim())
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
  }
  return rootOf()
}

function rootInfo(key) {
  return ROOTS.find((item) => item.key === key) || ROOTS[0]
}

function dashboardView(value) {
  const steps = value.steps.slice(0, 12).map((step) => ({
    label: step.label,
    status: step.status === 'done' ? 'done' : step.status === 'current' ? 'current' : 'todo',
  }))
  const children = [
    { type: 'text', text: value.project + (value.scenario ? ' · ' + value.scenario : '') },
    {
      type: 'row',
      children: [
        { type: 'metric', label: '管线', value: `${value.done}/${value.total}` },
        { type: 'metric', label: '结论', value: String(value.conclusions), caption: `${value.supported} 已支持` },
        { type: 'metric', label: '引用问题', value: String(value.citationIssues), tone: value.citationIssues ? 'warn' : 'good' },
      ],
    },
    { type: 'progress', value: value.pct, label: '研究闭环进度', caption: `${value.pct}%` },
  ]
  if (value.current) children.push({ type: 'text', text: '当前：' + value.current })
  if (steps.length) children.push({ type: 'steps', items: steps })
  children.push({ type: 'callout', tone: 'info', text: '需要下载或 WPS 打开文件时，请打开 dsh-Go 网页版的「叮咚鸡 Go」。' })
  return { type: 'stack', title: `叮咚鸡 · ${value.project}`, children }
}

function filesView(value) {
  const rows = value.entries.slice(0, 20).map((entry) => ({
    title: entry.name,
    subtitle: entry.dir ? '文件夹' : entry.sizeText,
    icon: entry.dir ? 'folder' : entry.document ? 'document' : 'text',
    trailing: entry.dir ? '›' : undefined,
  }))
  return {
    type: 'stack',
    title: `叮咚鸡 · ${value.rootLabel}（${value.entries.length} 项）`,
    children: [
      { type: 'text', text: value.path },
      rows.length ? { type: 'list', items: rows } : { type: 'text', text: '这个目录里还没有文件。' },
      { type: 'callout', tone: 'info', text: '原生卡片只读；下载/WPS 请用 dsh-Go 网页版。' },
    ],
  }
}

const nullableString = { oneOf: [{ type: 'string' }, { type: 'null' }] }
const stepSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['done', 'current', 'todo', 'failed'] },
  },
}

export function registerTools(ctx) {
  ctx.tools.register(defineTool({
    name: 'ddj_go_dashboard',
    description:
      '叮咚鸡移动端仪表盘：读取工作区工程文件里的项目名、管线步骤/进度、当前步骤、结论和引用核验问题。' +
      '用户想查看叮咚鸡项目进展时使用；结果会显示为原生卡片，不要重复卡片里的数字。',
    parameters: {
      workspace: { type: 'string', description: '可选：项目工作区绝对路径；不填则自动使用当前工作区。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: { type: 'string', required: true },
          scenario: { type: 'string' },
          done: { type: 'number', required: true },
          total: { type: 'number', required: true },
          pct: { type: 'number', required: true },
          current: { ...nullableString, required: true },
          conclusions: { type: 'number', required: true },
          supported: { type: 'number', required: true },
          citationIssues: { type: 'number', required: true },
          workspace: { type: 'string', required: true },
          steps: { type: 'array', required: true, items: stepSchema },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.project}：管线 ${value.done}/${value.total}（${value.pct}%），当前 ${value.current || '无'}；结论 ${value.conclusions}，引用问题 ${value.citationIssues}。` }],
      presentationMeta: toolCard((_args, value) => dashboardView(value)),
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    execute: (args, exec) => {
      exec.signal?.throwIfAborted?.()
      const workspace = workspaceOf(args.workspace)
      const data = projectData(workspace)
      return {
        project: data.project,
        scenario: data.scenario,
        done: data.done,
        total: data.total,
        pct: data.pct,
        current: data.current?.label || data.current?.id || null,
        conclusions: data.conclusions,
        supported: data.supported,
        citationIssues: data.citationIssues,
        workspace,
        steps: data.steps.map((step) => ({
          label: String(step.label || step.id),
          status: step.status === 'done' ? 'done' : step.id === data.current?.id || step.status === 'active' || step.status === 'current' ? 'current' : 'todo',
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ddj_go_files',
    description:
      '叮咚鸡工作区文件列表：浏览手稿（结果文件/manuscript）、图稿（结果文件/figures）、手稿文书目录。' +
      '用户想在手机上看有哪些手稿/图表/文档时使用；结果会显示为原生卡片。下载或 WPS 打开请提示用户到网页版。',
    parameters: {
      root: { type: 'string', enum: ['manuscript', 'figures', 'documents'], description: '目录：manuscript 手稿、figures 图稿、documents 手稿文书。默认 manuscript。' },
      path: { type: 'string', description: '可选：相对项目根的子路径。' },
      workspace: { type: 'string', description: '可选：项目工作区绝对路径；不填则自动使用当前工作区。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          rootLabel: { type: 'string', required: true },
          path: { type: 'string', required: true },
          workspace: { type: 'string', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                rel: { type: 'string', required: true },
                dir: { type: 'boolean', required: true },
                image: { type: 'boolean', required: true },
                document: { type: 'boolean', required: true },
                sizeText: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.rootLabel}：${value.entries.length} 项，路径 ${value.path}` }],
      presentationMeta: toolCard((_args, value) => filesView(value)),
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    execute: (args, exec) => {
      exec.signal?.throwIfAborted?.()
      const workspace = workspaceOf(args.workspace)
      const info = rootInfo(args.root)
      const relative = typeof args.path === 'string' && args.path.trim() ? args.path.trim().replace(/^\/+/, '') : info.dir
      const listing = listDir(workspace, relative)
      const sizeText = (bytes) => {
        if (!bytes) return '—'
        if (bytes < 1024) return bytes + ' B'
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
        return (bytes / 1024 / 1024).toFixed(1) + ' MB'
      }
      return {
        root: info.key,
        rootLabel: info.zh,
        path: relative,
        workspace,
        entries: listing.entries.map((entry) => ({
          name: entry.name,
          rel: entry.rel,
          dir: !!entry.dir,
          image: !!entry.image,
          document: !!entry.document,
          sizeText: sizeText(entry.size),
        })),
      }
    },
  }))
}
