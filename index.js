// 卡片工坊 · Host 半
// 1. 三个工具：cards_prepare 拆页脱敏、cards_list_folders 列子文件夹、cards_build 排版出 PDF
// 2. /card-workshop/api/*：给面板用的文件接口。本机的目录选择器只编了 native 一种实现，
//    客户端 listDirectory 一律被拒，所以列目录这件事由这里用 node:fs 自己做。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, normalize } from 'node:path'
import { DEFAULT_ROOT, listFolders, prepare, renderPageImages, sweepOldBatches } from './lib/prepare.js'
import { build, checkDeck, writeCoverage } from './lib/build.js'
import { readCourse, scopeText, writeCourse } from './lib/course.js'

export const name = 'card-workshop'
export const inject = ['tools', 'webServer']

const BASE = '/card-workshop'
const text = (v) => [{ type: 'text', text: v }]
const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const OUTPUT = { type: 'object', additionalProperties: true }

const prepareTool = {
  name: 'cards_prepare',
  description:
    '卡片工坊第一步：拆页、脱敏，文字压掉空格后按 10 页一段写进 .work/<批次>/pages/，页图只给扫描页和乱码页出。返回批次号，并写好 plan.md——先读它再动手。目标子文件夹不存在时返回 ok:false 和候选名，先问用户打错了还是新建，得到答复再带 create:true 重跑。',
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
  description: '列出母文件夹下的一级子文件夹（带上二级名字），用来确认目标子文件夹，或给用户挑。',
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
    '读 .work/<批次>/deck.json，或 parts/*.json（自动合并、按题型并题、重排卡号），加 coverage.json，校验通过后排版并编译成卡片 PDF，落到目标子文件夹。校验项：覆盖每一页且 reviewed、三类条目数与 deck 相等、题目 id 不重复、无敏感信息。失败返回 errors，不许跳过。同批次重编覆盖同名成品；报错指到某张卡时只改对应那条。',
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
      reviewed: str('没写过 coverage.json 时给：你确认看过的页，通常 all；写了就不必传'),
    },
  },
  timeoutMs: 600000,
  output: {
    schema: OUTPUT,
    render: (_a, v) => text(
      v.ok
        ? `出好了：${v.pdf}（${v.pages} 页）\n定义 ${v.counts.definitions} 条 · 定理 ${v.counts.theorems} 条 · 题型 ${v.counts.types} 类 · 题目 ${v.counts.problems} 道${v.warnings?.length ? '\n提醒：\n- ' + v.warnings.join('\n- ') : ''}`
        : `没出：${v.message}${v.errors?.length ? '\n' + v.errors.slice(0, 12).map((e) => '- ' + e).join('\n') : ''}${v.log ? '\n' + v.log : ''}`,
    ),
  },
  async execute(args) {
    const root = args.root || DEFAULT_ROOT
    return build({ root, batch: args.batch, deckPath: args.deckPath, coveragePath: args.coveragePath, keepWork: Boolean(args.keepWork), keepVersions: Boolean(args.keepVersions), reviewed: args.reviewed })
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
    '从 parts 机械汇总每页条目数并写 coverage.json，你只需声明 reviewed（通常 all）。会顺手指出「正文很长却一条没抽到」的页——coverage 跟 deck 同源，对得上不算本事，那几页才是可能漏的。',
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
        ? `coverage 写好了：${v.pages} 页，定义 ${v.counts.definitions} · 定理 ${v.counts.theorems} · 题目 ${v.counts.problems}。${v.empty.length ? `\n一条没抽到的页：${v.empty.join('、')}` : ''}${v.suspicious.length ? `\n⚠ 这几页正文很长却一条没抽到，回头看看：${v.suspicious.map((s) => `第 ${s.page} 页（${s.chars} 字符）`).join('、')}` : ''}`
        : `没写成：${v.message}`,
    ),
  },
  async execute(args) {
    return writeCoverage({ root: args.root || DEFAULT_ROOT, batch: args.batch, reviewed: args.reviewed || 'all' })
  },
}

const checkTool = {  name: 'cards_check',
  description:
    '体检，只报结论不返正文：覆盖率、条目数、题号重复、题干抄重、内容多却抽空的页、deck 里的敏感信息。写完 deck 先跑它，过了再 cards_build。',
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
    '给某几页补页图。文字层读不通、或页面有分式/积分/矩阵这种被文字层拍平的排版时用：一次把一段（10 页内）取齐，连着 read_image 看完再写，读过的别重取。一页约 1000—1500 token，别整本都要。',
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

const cleanupTool = {
  name: 'cards_cleanup',
  description:
    '清掉母文件夹 .work 下的批次中间产物。成品 PDF 在子文件夹里，删中间产物不影响它。默认清全部批次；传 hours 只清那么久没动过的（比如 12）。正在被别的会话使用的批次会自动跳过，不会删坏。重编之前别跑到它。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      root: str('母文件夹绝对路径，默认 D:\\卡片库'),
      hours: { type: 'integer', description: '只清这么多小时没动过的批次；默认 0，也就是清掉 5 分钟以上没动过的全部' },
    },
  },
  timeoutMs: 60000,
  output: {
    schema: OUTPUT,
    render: (_a, v) => text(v.removed.length ? `清掉 ${v.removed.length} 个批次：\n- ${v.removed.join('\n- ')}` : '没有可清的批次，.work 已经是干净的'),
  },
  async execute(args) {
    const removed = sweepOldBatches(args.root || DEFAULT_ROOT, args.hours ?? 0)
    return { ok: true, removed }
  },
}

const courseTool = {
  name: 'cards_course',
  description:
    '读写一个科目的教材与进度，存成 <母文件夹>/<科目>/课程.json。首次给某个科目生成卡片时，先问用户参考教材（书名+版次），自己去网上查目录，再问做到第几章第几节，然后用 set 写进来。之后 prepare 会把「该章节及之前」当成解题可用的知识范围。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: str('get：读；set：写', { enum: ['get', 'set'] }),
      subject: str('科目名，也就是母文件夹下的一级目录，例如「高等数学分析」'),
      root: str('母文件夹绝对路径，默认 D:\\卡片库'),
      textbook: str('参考教材，书名 + 版次，例如「《数学分析》陈纪修 第三版」'),
      chapters: { type: 'array', items: { type: 'string' }, description: '教材章节目录，按顺序' },
      current: { type: 'object', description: '这次做到哪里：{"chapter":"第二章 函数极限","section":"2.3 无穷小量与无穷大量"}' },
      forbidden: { type: 'array', items: { type: 'string' }, description: '明确还不许用的方法，例如 ["泰勒展开","洛必达法则"]' },
    },
  },
  timeoutMs: 20000,
  output: {
    schema: OUTPUT,
    render: (_a, v) => text(v.ok ? v.message : '失败：' + v.message),
  },
  async execute(args) {
    const root = args.root || DEFAULT_ROOT
    const subject = String(args.subject || '').trim()
    if (!subject) return { ok: false, message: '要给科目名（一级目录）' }
    if (args.action === 'get') {
      const c = readCourse(root, subject)
      if (!c.found) return { ok: false, message: `${subject} 还没有 课程.json（${c.file || ''}）${c.reason ? '：' + c.reason : ''}` }
      return { ok: true, message: `${subject}：${c.textbook || '（没写教材）'}\n范围：${scopeText(c)}` }
    }
    const prev = readCourse(root, subject)
    const data = {
      textbook: args.textbook || (prev.found ? prev.textbook : ''),
      chapters: Array.isArray(args.chapters) && args.chapters.length ? args.chapters : prev.chapters || [],
      current: args.current || prev.current || {},
      forbidden: Array.isArray(args.forbidden) ? args.forbidden : prev.forbidden || [],
      updatedAt: new Date().toISOString(),
    }
    if (!data.textbook || !data.chapters.length || !data.current || !data.current.chapter) {
      return { ok: false, message: 'textbook、chapters、current.chapter 三样都要有，缺的补上再写' }
    }
    const file = writeCourse(root, subject, data)
    return { ok: true, message: `写好了：${file}\n${scopeText({ found: true, ...data })}` }
  },
}

const rebuildTool = {
  name: 'cards_rebuild',
  description:
    '拿成品旁边的结构快照重编，不读 PDF、不花阅读成本。每份成品都会留 <成品名>.deck.json 和 <成品名>.manifest.json；要改内容就编辑 deck.json，再跑这个，默认覆盖同名 PDF。适合换版式、补字段、改文案这类不需要重读原文的修改。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['deckPath'],
    properties: {
      deckPath: str('成品旁边的 deck 快照路径，例如 D:\\卡片库\\高数\\第一章\\第一章-20261115-120000.deck.json'),
      keepVersions: { type: 'boolean', description: '另存一份而不是覆盖同名 PDF，默认 false' },
    },
  },
  timeoutMs: 600000,
  output: {
    schema: OUTPUT,
    render: (_a, v) => text(
      v.ok
        ? `重编好了：${v.pdf}（${v.pages} 页）\n定义 ${v.counts.definitions} · 定理 ${v.counts.theorems} · 题型 ${v.counts.types} · 题目 ${v.counts.problems}${v.warnings?.length ? '\n提醒：\n- ' + v.warnings.join('\n- ') : ''}`
        : `没编成：${v.message}${v.errors?.length ? '\n' + v.errors.slice(0, 8).map((e) => '- ' + e).join('\n') : ''}${v.log ? '\n' + v.log : ''}`,
    ),
  },
  async execute(args) {
    const deckPath = String(args.deckPath || '')
    if (!existsSync(deckPath)) return { ok: false, message: '没有这个 deck：' + deckPath }
    const stem = deckPath.replace(/\.deck\.json$/i, '')
    const manFile = stem + '.manifest.json'
    if (!existsSync(manFile)) return { ok: false, message: '找不到配套的 ' + basename(manFile) + '，没法确定落盘位置和页数' }
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manFile, 'utf8'))
    } catch (e) {
      return { ok: false, message: 'manifest 读不出来：' + e.message }
    }
    if (!manifest.root || !manifest.targetPath) return { ok: false, message: 'manifest 里缺 root 或 targetPath' }
    const batch = `rebuild-${Date.now().toString(36)}`
    const work = join(manifest.root, '.work', batch)
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    writeFileSync(join(work, 'deck.json'), readFileSync(deckPath))
    return build({ root: manifest.root, batch, reviewed: 'all', keepVersions: Boolean(args.keepVersions) })
  },
}

export function apply(ctx) {
  for (const tool of [prepareTool, listTool, buildTool, checkTool, coverageTool, pageImageTool, cleanupTool, courseTool, rebuildTool]) {
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
