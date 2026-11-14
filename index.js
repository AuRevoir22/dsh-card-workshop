// 卡片工坊 · Host 半
// 1. 三个工具：cards_prepare 拆页脱敏、cards_list_folders 列子文件夹、cards_build 排版出 PDF
// 2. /card-workshop/api/*：给面板用的文件接口。本机的目录选择器只编了 native 一种实现，
//    客户端 listDirectory 一律被拒，所以列目录这件事由这里用 node:fs 自己做。
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { DEFAULT_ROOT, listFolders, prepare, renderPageImages } from './lib/prepare.js'
import { build, checkDeck, writeCoverage } from './lib/build.js'

export const name = 'card-workshop'
export const inject = ['tools', 'webServer']

const BASE = '/card-workshop'
const text = (v) => [{ type: 'text', text: v }]
const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const OUTPUT = { type: 'object', additionalProperties: true }

const prepareTool = {
  name: 'cards_prepare',
  description:
    '卡片工坊第一步：把源 PDF 拆成逐页文字和按需页图，放进母文件夹的 .work/<批次>/ 里，同时把校名、姓名、学号这类敏感信息替换掉。返回批次号，并写好 .work/<批次>/plan.md（段表、条目格式、覆盖记录写法都在里面）——动手前先读 plan.md，别在对话里另立格式。文字按每 10 页合并成 pages/part-XX.md，一次读一段，不要一页一页读。页图默认只给扫描页和文字层稀烂的页出（auto），其余页要看图用 cards_page_image。目标子文件夹不存在时返回 ok:false 和候选名，先问用户是打错了还是新建，得到答复再带 create:true 重跑。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['target', 'sources'],
    properties: {
      sources: { type: 'array', items: { type: 'string' }, description: '源 PDF 绝对路径，可以给多个（会合并成一份卡片 PDF）' },
      target: str('目标子文件夹，相对母文件夹，一到两级，例如「高等数学/第一章 极限」'),
      root: str('母文件夹绝对路径，默认 D:\\卡片库'),
      images: str('页图策略：auto（默认，只出扫描页和烂页）、all（每页都出，贵）、none（一张不出）', { enum: ['auto', 'all', 'none'] }),
      dpi: { type: 'integer', description: '页图分辨率，默认 120' },
      chunk: { type: 'integer', description: '每段合并多少页，默认 10' },
      create: { type: 'boolean', description: '目标子文件夹不存在时是否新建；默认 false，必须先问过用户' },
    },
  },
  timeoutMs: 600000,
  output: {
    schema: OUTPUT,
    render: (_a, v) => text(
      v.ok
        ? (v.textUsable ? '' : `⚠ 文字层不可用：${v.brokenPages}/${v.totalPages} 页抽出来是乱码（字体没带 ToUnicode）。已按整本出图，pages/*.md 别读，直接 read_image img/page-XXX.png。\n`) +
          `批次 ${v.batch}：${v.totalPages} 页（扫描页 ${v.scannedPages}，出图 ${v.imagePages} 页），目标 ${v.targetPath}${v.created ? '（新建）' : ''}。\n施工单：${v.plan}\n正文 ${v.charCount} 字符（原始 ${v.rawCharCount}，压掉 ${Math.round((1 - v.charCount / Math.max(1, v.rawCharCount)) * 100)}%），分 ${v.parts.length} 段。\n脱敏：${v.redactions.map((r) => r.kind + '×' + r.count).join('、') || '无命中'}`
        : `没准备好：${v.message || v.code}${v.suggestions?.length ? '；母文件夹里相近的：' + v.suggestions.join('、') : ''}${v.ask ? '。' + v.ask : ''}`,
    ),
  },
  async execute(args) {
    return prepare({
      root: args.root || DEFAULT_ROOT,
      target: args.target,
      sources: args.sources,
      images: args.images || 'auto',
      dpi: args.dpi || 120,
      chunk: args.chunk || 10,
      create: Boolean(args.create),
    })
  },
}

const listTool = {
  name: 'cards_list_folders',
  description: '列出母文件夹下的子文件夹（两级），用来确认目标子文件夹的名字，或给用户挑。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { root: str('母文件夹绝对路径，默认 D:\\卡片库') },
  },
  timeoutMs: 20000,
  output: {
    schema: OUTPUT,
    render: (_a, v) => text(v.exists ? `${v.root}：\n` + v.levels.map((l) => `- ${l.name}${l.children.length ? '：' + l.children.join('、') : '（无二级）'}`).join('\n') : `母文件夹还不存在：${v.root}`),
  },
  async execute(args) {
    return listFolders(args.root || DEFAULT_ROOT)
  },
}

const buildTool = {
  name: 'cards_build',
  description:
    '卡片工坊第三步：读 .work/<批次>/deck.json，或者 parts/*.json（分片写时用，会自动合并、按题型并题、重排卡号），加上 coverage.json，校验通过后排版并编译成卡片 PDF，落到目标子文件夹。校验包括：coverage 覆盖每一页且 reviewed:true、三类条目数与 deck 完全相等、题目 id 不重复、deck 里不能再有敏感信息。校验没过就返回 errors，不许跳过。同一批次重编会覆盖同名成品。报错指到某一张卡时，只改那个 part 里的对应条目，别整段重写。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['batch'],
    properties: {
      batch: str('cards_prepare 返回的批次号'),
      root: str('母文件夹绝对路径，默认 D:\\卡片库'),
      deckPath: str('deck.json 路径，默认 .work/<批次>/deck.json'),
      coveragePath: str('coverage.json 路径，默认 .work/<批次>/coverage.json'),
      keepWork: { type: 'boolean', description: '保留 .work/<批次> 中间产物，默认 false（编完就删）' },
      keepVersions: { type: 'boolean', description: '同一批次重编时另起序号、保留旧版，默认 false（覆盖同名成品）' },
    },
  },
  timeoutMs: 600000,
  output: {
    schema: OUTPUT,
    render: (_a, v) => text(
      v.ok
        ? `出好了：${v.pdf}（${v.pages} 页）\n定义 ${v.counts.definitions} 条 · 定理 ${v.counts.theorems} 条 · 题型 ${v.counts.types} 类 · 题目 ${v.counts.problems} 道`
        : `没出：${v.message}${v.errors?.length ? '\n' + v.errors.slice(0, 12).map((e) => '- ' + e).join('\n') : ''}${v.log ? '\n' + v.log : ''}`,
    ),
  },
  async execute(args) {
    const root = args.root || DEFAULT_ROOT
    return build({ root, batch: args.batch, deckPath: args.deckPath, coveragePath: args.coveragePath, keepWork: Boolean(args.keepWork), keepVersions: Boolean(args.keepVersions) })
  },
}

// ---- 面板用的文件接口 ----

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function safeDir(path) {
  if (!path) return null
  const p = normalize(String(path))
  if (!existsSync(p)) return null
  try {
    return statSync(p).isDirectory() ? p : null
  } catch {
    return null
  }
}

function listOne(dir) {
  const out = []
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue
    let isDir = d.isDirectory()
    if (!isDir && !d.isFile()) {
      try {
        isDir = statSync(join(dir, d.name)).isDirectory()
      } catch {
        continue
      }
    }
    out.push({ name: d.name, path: join(dir, d.name), dir: isDir })
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1))
  return out
}

function tree(root) {
  const levels = []
  for (const name of listOne(root).filter((e) => e.dir)) {
    let children = []
    try {
      children = listOne(join(root, name.name)).filter((e) => e.dir).map((e) => e.name)
    } catch {}
    levels.push({ name: name.name, children })
  }
  return levels
}

function readJson(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.method !== 'POST') return reject(Object.assign(new Error('method'), { status: 405 }))
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > max) req.destroy()
      else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(Object.assign(e, { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function apiHandler(req, res) {
  const url = new URL(req.url || '/', 'http://x')
  const rest = decodeURIComponent(url.pathname.slice(BASE.length)) || '/'
  const q = (k) => url.searchParams.get(k)

  if (rest === '/api/status') return sendJson(res, 200, { ok: true, api: 'card-workshop' })

  if (rest === '/api/list') {
    const dir = safeDir(q('dir'))
    if (!dir) return sendJson(res, 200, { ok: false, message: '目录打不开：' + (q('dir') || '(空)') })
    try {
      return sendJson(res, 200, { ok: true, dir, entries: listOne(dir) })
    } catch (e) {
      return sendJson(res, 200, { ok: false, message: String(e.message || e) })
    }
  }

  if (rest === '/api/tree') {
    const dir = safeDir(q('root'))
    if (!dir) return sendJson(res, 200, { ok: false, exists: false, root: q('root'), levels: [] })
    try {
      return sendJson(res, 200, { ok: true, exists: true, root: dir, levels: tree(dir) })
    } catch (e) {
      return sendJson(res, 200, { ok: false, message: String(e.message || e) })
    }
  }

  if (rest === '/api/mkdir') {
    return readJson(req).then((body) => {
      const parent = safeDir(body.parent)
      const name = String(body.name || '').trim()
      if (!parent) return sendJson(res, 200, { ok: false, message: '父目录不在：' + body.parent })
      if (!name || /[\\/:*?"<>|]/.test(name) || name.startsWith('.')) return sendJson(res, 200, { ok: false, message: '这个名字不能当文件夹名' })
      const target = join(parent, name)
      if (existsSync(target)) return sendJson(res, 200, { ok: true, path: target, created: false })
      try {
        mkdirSync(target)
        return sendJson(res, 200, { ok: true, path: target, created: true })
      } catch (e) {
        return sendJson(res, 200, { ok: false, message: String(e.message || e) })
      }
    }).catch((e) => sendJson(res, e.status || 500, { ok: false, message: String(e.message || e) }))
  }

  return sendJson(res, 404, { ok: false, message: 'no such endpoint' })
}

const coverageTool = {
  name: 'cards_coverage',
  description:
    '从 parts/*.json 机械汇总每页抽到的条目数，写出 coverage.json。你只需要声明 reviewed（哪几页看过了，通常 all），不用手抄每页计数——数错了会卡住编译，抄一遍也不涨准确度。写完顺手报出哪些页一条都没抽到，回头确认那几页是不是本来就空。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['batch'],
    properties: {
      batch: str('cards_prepare 返回的批次号'),
      root: str('母文件夹绝对路径，默认 D:\\卡片库'),
      reviewed: str('你确认看过的页：all（默认）、1-71、1,3-7 这种写法'),
    },
  },
  timeoutMs: 30000,
  output: {
    schema: OUTPUT,
    render: (_a, v) => text(
      v.ok
        ? `coverage 写好了：${v.pages} 页，定义 ${v.counts.definitions} · 定理 ${v.counts.theorems} · 题目 ${v.counts.problems}。${v.empty.length ? `\n一条没抽到的页：${v.empty.join('、')}（确认这些页本来就空）` : ''}`
        : `没写成：${v.message}`,
    ),
  },
  async execute(args) {
    return writeCoverage({ root: args.root || DEFAULT_ROOT, batch: args.batch, reviewed: args.reviewed || 'all' })
  },
}

const checkTool = {  name: 'cards_check',
  description:
    '卡片工坊的体检：只报结论，不返回正文。核对覆盖率（页码是否 1..N 全覆盖、reviewed 是否都标了）、三类条目数与 deck 是否相等、题目 id 是否重复、题干有没有抄重、哪些页一条都没抽到、deck 里有没有敏感信息。写完 deck 先跑这个，通过了再 cards_build，别自己回头重读原文对数。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['batch'],
    properties: {
      batch: str('cards_prepare 返回的批次号'),
      root: str('母文件夹绝对路径，默认 D:\\卡片库'),
      deckPath: str('deck.json 路径，默认 .work/<批次>/deck.json 或 parts/'),
      coveragePath: str('coverage.json 路径，默认 .work/<批次>/coverage.json'),
    },
  },
  timeoutMs: 60000,
  output: {
    schema: OUTPUT,
    render: (_a, v) => text(
      v.ok
        ? `体检通过：${v.pages} 页，定义 ${v.counts.definitions} · 定理 ${v.counts.theorems} · 题型 ${v.counts.types} · 题目 ${v.counts.problems}${v.warnings.length ? '\n提醒：\n- ' + v.warnings.join('\n- ') : ''}`
        : `${v.message ? v.message + '\n' : ''}体检没过：\n- ${v.errors.join('\n- ')}${v.warnings.length ? '\n提醒：\n- ' + v.warnings.join('\n- ') : ''}`,
    ),
  },
  async execute(args) {
    return checkDeck({ root: args.root || DEFAULT_ROOT, batch: args.batch, deckPath: args.deckPath, coveragePath: args.coveragePath })
  },
}

const pageImageTool = {
  name: 'cards_page_image',
  description:
    '给某几页补出页图（默认只有扫描页和烂页有图）。文字层读不通、公式看不清时用。一次把一段（10 页内）的图都要齐，连着用 read_image 看完再动手写，别一页一个来回；已经读过的页不要再取。一页约 1000—1500 token，别整本都要。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['batch', 'pages'],
    properties: {
      batch: str('cards_prepare 返回的批次号'),
      root: str('母文件夹绝对路径，默认 D:\\卡片库'),
      pages: { type: 'array', items: { type: 'integer' }, description: '全局页号，从 1 开始' },
      dpi: { type: 'integer', description: '分辨率，默认 120' },
    },
  },
  timeoutMs: 180000,
  output: {
    schema: OUTPUT,
    render: (_a, v) => text(v.ok ? `出了 ${v.made.length} 张：\n${v.made.map((m) => `p.${m.page} → ${m.file}`).join('\n')}` : `没出成：${v.message}`),
  },
  async execute(args) {
    const work = join(args.root || DEFAULT_ROOT, '.work', args.batch)
    if (!existsSync(work)) return { ok: false, message: '没有这个批次：' + args.batch }
    try {
      const made = await renderPageImages(work, args.pages || [], args.dpi || 120)
      return { ok: true, made }
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) }
    }
  },
}

export function apply(ctx) {
  for (const tool of [prepareTool, listTool, buildTool, checkTool, coverageTool, pageImageTool]) {
    ctx.effect(() => ctx.tools.register(tool))
  }
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: BASE,
      async handler(req, res) {
        try {
          await apiHandler(req, res)
        } catch (e) {
          try {
            sendJson(res, 500, { ok: false, message: String((e && e.message) || e) })
          } catch {}
        }
      },
    }),
  )
}
