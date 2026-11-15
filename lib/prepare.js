// 抽取准备：把源 PDF 拆成逐页文字 + 按需页图，顺手把敏感信息换掉。
// 文字层能抠到的东西在这里就脱敏，模型看到的是替换后的版本。
// 省钱的三处：空格压掉一半、正文按 10 页一段合并成 md、页图只给需要的页出。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

const run = promisify(execFile)
export const DEFAULT_ROOT = 'D:\\卡片库'
const CHUNK = 10

const EXEC = { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true }

export function dirsOf(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'zh'))
  } catch {
    return []
  }
}

export function listFolders(root) {
  const exists = existsSync(root)
  return {
    root,
    exists,
    levels: exists ? dirsOf(root).map((name) => ({ name, children: dirsOf(join(root, name)) })) : [],
  }
}

// 两字符的相对重叠，够用来把「第一章 极限」和「第一章 极限理论」这种手误挑出来
function near(name, names) {
  const a = name.replace(/\s/g, '')
  return names
    .map((n) => {
      const b = n.replace(/\s/g, '')
      let hit = 0
      for (const ch of new Set(a)) if (b.includes(ch)) hit++
      return { n, score: hit / Math.max(1, new Set(a).size) }
    })
    .filter((x) => x.score >= 0.4)
    .sort((x, y) => y.score - x.score)
    .slice(0, 3)
    .map((x) => x.n)
}

export function resolveTarget(root, target, create) {
  const parts = String(target || '').split(/[\\/]+/).filter(Boolean)
  if (!parts.length) return { ok: false, code: 'empty', message: '没给目标子文件夹' }
  if (parts.length > 2) return { ok: false, code: 'depth', message: '子文件夹最多两级，你给的是 ' + parts.length + ' 级' }
  if (parts.some((p) => p === '.' || p === '..' || p.startsWith('.'))) return { ok: false, code: 'name', message: '文件夹名不能是 . 开头的隐藏名' }
  const parent = join(root, ...parts.slice(0, -1))
  const missing = !existsSync(parent)
  if (missing && create) {
    mkdirSync(join(root, ...parts), { recursive: true })
    return { ok: true, path: join(root, ...parts), created: true }
  }
  if (missing) {
    return {
      ok: false,
      code: 'missing',
      message: '母文件夹下没有「' + parts[0] + '」这一层',
      suggestions: near(parts[0], dirsOf(root)),
      ask: '名字打错了，还是要新建？',
    }
  }
  const full = join(root, ...parts)
  if (existsSync(full)) {
    if (statSync(full).isDirectory()) return { ok: true, path: full, created: false }
    return { ok: false, code: 'file', message: '「' + parts.join('/') + '」是一个文件，不是文件夹' }
  }
  if (!create) {
    return {
      ok: false,
      code: 'missing',
      message: '没找到子文件夹「' + parts.join('/') + '」',
      suggestions: near(parts[parts.length - 1], dirsOf(parent)),
      ask: '名字打错了，还是要新建？',
    }
  }
  mkdirSync(full)
  return { ok: true, path: full, created: true }
}

// 只写计数，不把原文里的名字留在任何文件里
const RULES = [
  { kind: '姓名', re: /(姓名|学生姓名|考生姓名|学生|考生|教师|任课教师|指导教师|命题人|出题人)\s*[:：]\s*[\u4e00-\u9fa5]{2,4}/g, to: '$1：某某' },
  { kind: '学号', re: /(学号|考号|座号|准考证号|编号)\s*[:：]?\s*[0-9A-Za-z]{5,}/g, to: '$1：×××' },
  { kind: '校名', re: /[\u4e00-\u9fa5]{2,12}(大学|学院|中学|附中|小学|学校|中学部)/g, to: '某校' },
  { kind: '班级', re: /[一二三四五六七八九十0-9]{1,3}\s*班(?!级|次)/g, to: '某班' },
  { kind: '电话', re: /\b1[3-9]\d{9}\b/g, to: '×××' },
  { kind: '邮箱', re: /[\w.+-]+@[\w-]+\.[\w.]+/g, to: '×××@××' },
]

export function scrub(text) {
  let out = text
  const hits = []
  for (const rule of RULES) {
    const n = (out.match(rule.re) || []).length
    if (!n) continue
    out = out.replace(rule.re, rule.to)
    hits.push({ kind: rule.kind, count: n })
  }
  return { text: out, hits }
}

export function scanSensitive(text) {
  const found = []
  for (const rule of RULES) {
    const n = (String(text).match(rule.re) || []).length
    if (n) found.push({ kind: rule.kind, count: n })
  }
  return found
}

// -layout 为了保住列对齐塞了大量空格，实测能占一半字符，压掉不影响阅读顺序。
// 表格、选择题选项靠空格分列，这种页不压。
export function compactPage(text) {
  const lines = String(text).replace(/\r/g, '').split('\n')
  if (isTabular(lines)) {
    const out = []
    let blank = 0
    for (const line of lines) {
      const kept = line.replace(/[ \t]+$/, '')
      if (!kept.trim()) {
        blank++
        continue
      }
      if (blank) out.push('')
      blank = 0
      out.push(kept)
    }
    return out.join('\n')
  }
  const out = []
  let blank = 0
  for (const line of lines) {
    const t = line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '').replace(/[ \t]{2,}/g, ' ')
    if (!t) {
      blank++
      continue
    }
    if (blank && out.length) out.push('')
    blank = 0
    out.push(t)
  }
  return out.join('\n')
}

// 一页里行内大空白特别密，多半是表格或并排选项
function isTabular(lines) {
  let gaps = 0
  for (const line of lines) {
    const m = line.replace(/^[ \t]+/, '').match(/[ \t]{2,}/g)
    if (m) gaps += m.length
    if (gaps >= 8) return true
  }
  return false
}

// 每页都一样的页眉页脚（作者名、课程名）跟正文无关，占几个百分点
function findBoilerplate(texts) {
  if (texts.length < 4) return new Set()
  const counts = new Map()
  for (const text of texts) {
    const seen = new Set()
    for (const line of String(text).split('\n')) {
      const s = line.trim()
      if (s.length < 6 || s.length > 120 || seen.has(s)) continue
      seen.add(s)
      counts.set(s, (counts.get(s) || 0) + 1)
    }
  }
  const limit = Math.max(3, Math.ceil(texts.length * 0.5))
  return new Set([...counts].filter(([, n]) => n > limit).map(([s]) => s))
}

function stripBoilerplate(text, boiler) {
  if (!boiler || !boiler.size) return text
  return String(text)
    .split('\n')
    .filter((line) => !boiler.has(line.trim()))
    .join('\n')
}

function looksBroken(text) {
  const t = String(text).trim()
  if (t.length < 20) return true
  const cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length
  const ascii = (t.match(/[\x20-\x7e]/g) || []).length
  // GBK 解码失败的典型字，短页靠它兜底
  if ((t.match(/[鈥锟閿鎴鍑鐨鍦鏄]/g) || []).length >= 2) return true
  // CID 字体没带 ToUnicode 时，中文会抽成 ê 4• ½ 这类拉丁补充字符
  const latin1 = (t.match(/[\u0080-\u00ff]/g) || []).length
  if (t.length > 120 && latin1 / t.length > 0.12 && cjk / t.length < 0.08) return true
  // 更常见的坏法：UTF-8 字节被当 GBK 解，出来一堆「鈥?鍑」这种像中文又不是中文的字
  if (t.length >= 120) {
    const common = (t.match(/[的是在和有不一中了个这们上下来去说时要会可对能也就被把让给还]|。/g) || []).length
    if (common <= 1) return true
  }
  return (cjk + ascii) / t.length < 0.45
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function slug(name) {
  return name.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 24) || 'batch'
}

async function pdfPages(file) {
  const { stdout } = await run('pdfinfo', [file], EXEC)
  const m = /^Pages:\s+(\d+)/m.exec(stdout)
  if (!m) throw new Error('读不出页数：' + file)
  return Number(m[1])
}

function ranges(nums) {
  const out = []
  const sorted = [...nums].sort((a, b) => a - b)
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    out.push([sorted[i], sorted[j]])
    i = j + 1
  }
  return out
}

// 按页出图：需要的页一页一个文件，名字固定成 page-<全局页号>.png
async function renderPages(work, sourcesInfo, pagesList, dpi) {
  const imgDir = join(work, 'img')
  mkdirSync(imgDir, { recursive: true })
  const made = []
  for (const page of pagesList) {
    const src = sourcesInfo[page.source - 1]
    if (!src) continue
    const local = join(work, 'src', `${page.source}-${src.name}`)
    if (!existsSync(local)) continue
    const prefix = join(imgDir, `page-${String(page.n).padStart(3, '0')}`)
    await run('pdftoppm', ['-png', '-r', String(dpi), '-f', String(page.sourcePage), '-l', String(page.sourcePage), '-singlefile', local, prefix], EXEC)
    const file = prefix + '.png'
    if (existsSync(file)) {
      page.image = file
      made.push({ page: page.n, file })
    }
  }
  return made
}

// 给工具用：读 manifest，按页补图，写回去。已经有图的页也一起返回，别让模型以为没取到
export async function renderPageImages(work, pages, dpi = 120) {
  const manifestFile = join(work, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const wanted = new Set((pages || []).map(Number))
  const all = manifest.pages.filter((p) => wanted.has(p.n))
  const existing = all.filter((p) => p.image).map((p) => ({ page: p.n, file: p.image, existed: true }))
  const need = all.filter((p) => !p.image)
  const made = await renderPages(work, manifest.sources, need, dpi)
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8')
  return [...existing, ...made].sort((a, b) => a.page - b.page)
}

// 清掉 .work 下超过 N 小时没动过的批次；keep 里的名字跳过。
// 不管传多小都留 5 分钟缓冲，免得把别的会话正在编的批次删掉。
export function sweepOldBatches(root, hours = 12, keep = []) {
  const dir = join(root, '.work')
  if (!existsSync(dir)) return []
  const window = Math.max(Number(hours) || 0, 0.08)
  const cut = Date.now() - window * 3600 * 1000
  const removed = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    if (keep.includes(entry.name)) continue
    try {
      if (statSync(full).mtimeMs > cut) continue
      rmSync(full, { recursive: true, force: true })
      removed.push(entry.name)
    } catch {
      // 正被别的会话用着就跳过，下次再说
    }
  }
  return removed
}

export async function prepare({ root = DEFAULT_ROOT, target, sources, images = 'auto', dpi = 120, create = false, chunk = CHUNK } = {}) {
  if (!Array.isArray(sources) || !sources.length) throw new Error('没给源文件')
  const mode = images === true ? 'all' : images === false ? 'none' : String(images || 'auto')
  mkdirSync(root, { recursive: true })
  sweepOldBatches(root, 12)
  const resolved = resolveTarget(root, target, create)
  if (!resolved.ok) return resolved

  const batch = `${stamp()}-${slug(basename(sources[0], extname(sources[0])))}`
  const work = join(root, '.work', batch)
  const dirs = { root: work, src: join(work, 'src'), txt: join(work, 'txt'), raw: join(work, 'raw'), img: join(work, 'img'), pages: join(work, 'pages'), parts: join(work, 'parts') }
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })

  const pages = []
  const sourcesInfo = []
  const allHits = []
  const drafts = []

  for (let si = 0; si < sources.length; si++) {
    const source = sources[si]
    if (extname(source).toLowerCase() !== '.pdf') throw new Error('只吃 PDF：' + source)
    if (!existsSync(source)) throw new Error('文件不存在：' + source)
    const total = await pdfPages(source)
    const local = join(dirs.src, `${si + 1}-${basename(source)}`)
    copyFileSync(source, local)

    const { stdout: raw } = await run('pdftotext', ['-enc', 'UTF-8', '-layout', local, '-'], EXEC)
    const chunks = raw.split('\f')
    if (chunks.length && chunks[chunks.length - 1].trim() === '') chunks.pop()

    for (let pi = 0; pi < total; pi++) {
      const scrubbed = scrub(chunks[pi] || '')
      allHits.push(...scrubbed.hits)
      drafts.push({ source: si + 1, sourcePage: pi + 1, text: scrubbed.text })
    }
    sourcesInfo.push({ file: source, name: basename(source), pages: total })
  }

  // 每页都一样的页眉页脚跟内容无关，先找出来再剔掉
  const boiler = findBoilerplate(drafts.map((d) => d.text))

  for (const draft of drafts) {
    const n = pages.length + 1
    const body = stripBoilerplate(draft.text, boiler)
    const textFile = join(dirs.txt, `page-${String(n).padStart(3, '0')}.txt`)
    const compact = compactPage(body)
    writeFileSync(textFile, compact, 'utf8')
    writeFileSync(join(dirs.raw, `page-${String(n).padStart(3, '0')}.txt`), draft.text, 'utf8')
    pages.push({
      n,
      source: draft.source,
      sourcePage: draft.sourcePage,
      text: textFile,
      raw: join(dirs.raw, `page-${String(n).padStart(3, '0')}.txt`),
      chars: compact.trim().length,
      rawChars: draft.text.trim().length,
      scanned: compact.trim().length < 20,
      needImage: looksBroken(body),
    })
  }

  // 页图：all 一次出完；auto 只给扫描页/烂页；整份文字层都烂就直接全出，不然模型读的是乱码
  const brokenPages = pages.filter((p) => p.needImage).length
  const textUsable = pages.length > 0 && brokenPages / pages.length < 0.35
  let imagePages = 0
  let effectiveMode = mode
  if (mode === 'auto' && !textUsable) effectiveMode = 'all'
  if (effectiveMode === 'all') {
    for (let si = 0; si < sources.length; si++) {
      const local = join(work, 'src', `${si + 1}-${sourcesInfo[si].name}`)
      await run('pdftoppm', ['-png', '-r', String(dpi), local, join(dirs.img, `s${si + 1}`)], EXEC)
      const files = readdirSync(dirs.img).filter((f) => f.startsWith(`s${si + 1}-`) && f.endsWith('.png')).sort()
      files.forEach((f, i) => {
        const page = pages.find((p) => p.source === si + 1 && p.sourcePage === i + 1)
        if (!page) return
        // 统一改成 page-<全局页号>.png，多源 PDF 才不会对不上号
        const to = join(dirs.img, `page-${String(page.n).padStart(3, '0')}.png`)
        const from = join(dirs.img, f)
        if (from !== to) renameSync(from, to)
        page.image = to
      })
    }
    imagePages = pages.filter((p) => p.image).length
  } else if (mode === 'auto') {
    const need = pages.filter((p) => p.needImage && !p.image)
    if (need.length) {
      const made = await renderPages(work, sourcesInfo, need, dpi)
      imagePages = made.length
    }
  }

  // 正文按 chunk 页一段，模型一次读一段，省来回
  const partList = []
  for (let start = 0; start < pages.length; start += chunk) {
    const slice = pages.slice(start, start + chunk)
    const name = `part-${String(partList.length + 1).padStart(2, '0')}.md`
    const body = slice
      .map((p) => `### p.${p.n}${p.scanned ? '（扫描页，没有文字层）' : ''}\n${readFileSync(p.text, 'utf8').trim() || '（空）'}`)
      .join('\n\n')
    writeFileSync(
      join(dirs.pages, name),
      `<!-- 第 ${slice[0].n}—${slice[slice.length - 1].n} 页，共 ${slice.length} 页 -->\n\n${textUsable ? '' : '> 这份文件的文字层是乱码（字体没带 ToUnicode），下面这段别读，直接看 img/page-XXX.png。\n\n'}${body}\n`,
      'utf8',
    )
    partList.push({ file: join(dirs.pages, name), from: slice[0].n, to: slice[slice.length - 1].n })
  }

  const redactions = new Map()
  for (const h of allHits) redactions.set(h.kind, (redactions.get(h.kind) || 0) + h.count)
  const manifest = {
    batch,
    root,
    target: partsOf(target),
    targetPath: resolved.path,
    createdAt: new Date().toISOString(),
    imageMode: effectiveMode,
    textUsable,
    dpi,
    chunk,
    sources: sourcesInfo,
    pages,
    parts: partList,
    totalPages: pages.length,
    scannedPages: pages.filter((p) => p.scanned).length,
    imagePages,
    charCount: pages.reduce((n, p) => n + p.chars, 0),
    rawCharCount: pages.reduce((n, p) => n + p.rawChars, 0),
    redactions: [...redactions].map(([kind, count]) => ({ kind, count })),
  }
  writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  const planFile = join(work, 'plan.md')
  writeFileSync(planFile, buildPlan(manifest, partList), 'utf8')
  return {
    ok: true,
    batch,
    work,
    plan: planFile,
    targetPath: resolved.path,
    created: resolved.created,
    totalPages: manifest.totalPages,
    scannedPages: manifest.scannedPages,
    imagePages,
    textUsable,
    brokenPages,
    charCount: manifest.charCount,
    rawCharCount: manifest.rawCharCount,
    parts: partList.map((p) => ({ file: p.file, from: p.from, to: p.to })),
    sources: sourcesInfo,
    redactions: manifest.redactions,
  }
}

// 一段一条的施工单：怎么读、写到哪、格式长什么样，都写在这儿，省得每次在对话里复述
function buildPlan(manifest, partList) {
  const pad = (n) => String(n).padStart(3, '0')
  const rows = partList.map((p, i) => {
    const inSlice = manifest.pages.filter((x) => x.n >= p.from && x.n <= p.to)
    const imgs = inSlice.filter((x) => x.image)
    const text = manifest.textUsable ? `pages/${basename(p.file)}` : '（别读，见右栏）'
    const img = imgs.length ? `${imgs.length} 张：${basename(imgs[0].image)} … ${basename(imgs[imgs.length - 1].image)}` : '无'
    return `| ${String(i + 1).padStart(2, '0')} | p.${p.from}–${p.to} | ${text} | ${img} |`
  })

  const howRead = manifest.textUsable
    ? `每段读 \`pages/part-NN.md\`（${manifest.chunk || 10} 页一段，一次读完）。**某一页里出现分式、积分、矩阵、分段函数、上下标叠层这种排版，就用 \`cards_page_image\` 取那页的图核一遍**——文字层会把分式拍平成一行、矩阵拆散，看着通顺其实错了。其余页不用出图。`
    : '这份文件的文字层是乱码（字体没带 ToUnicode），`pages/*.md` 别读，直接 `read_image` 读 `img/page-XXX.png`。一段最多 10 张，一次连着读完再动手。'

  return `# 卡片工坊 · 批次 ${manifest.batch}

目标文件夹：${manifest.targetPath}
共 ${manifest.totalPages} 页，分 ${partList.length} 段，每段 ${manifest.chunk} 页。

## 怎么干

1. ${howRead}
2. 一段读完立刻把条目写进 \`parts/${'NN'}.json\`，别攒着，写一段丢一段。写完不要复述内容，直接下一段。
3. 已经读过的段不要回头再读；改哪条就只写哪条。这份 plan.md 读一次就够，别每段都翻。
4. 全部写完直接 \`cards_build\`，带上 \`reviewed:"all"\`——它自己汇总覆盖记录，顺便做结构体检（裸 LaTeX、缺证明、题型拆重、题没详解这类），过了就出 PDF，没过就把问题列出来。重编要带 keepWork:true，不然批次目录会被删。
5. \`cards_build\` 只报某一张卡出错时，只改那个 part 里对应的一条，别整段重写。
6. 开工时按段建一份任务清单，全部写完、PDF 出好之后把每条标完成——清单不会自己消失，留到最后会挂在会话里。
7. 成品确认没问题后跑 \`cards_cleanup\` 把这一批的中间产物清掉；重编期间别跑。放超过 12 小时没人动的批次，下次 \`cards_prepare\` 或 \`cards_build\` 会自动清。

## 段表

| 段 | 页 | 文字 | 页图 |
|---|---|---|---|
${rows.join('\n')}

## 条目格式（parts/NN.json）

\`\`\`json
{"definitions":[{"page":12,"name":"函数在一点的极限","body":"原文定义，公式用 $…$","notation":"$\\\\lim f(x)=A$","gist":"最容易读漏的那个词","usage":"一句用法"}],"theorems":[{"page":13,"name":"单调有界准则","conditions":"…","conclusion":"…","proof":"…","usage":"…"}],"types":[{"name":"数列极限的四则运算","recognize":"…","method":"①…②…","pitfalls":"…","problems":[{"page":14,"statement":"完整题干","key":"切入点一句","solution":"完整详解"}]}]}
\`\`\`

要点：**紧凑写，别缩进**（缩进不提升可解析性，只烧 token）；\`page\` 必填（全局页号）；题干和证明照原文，不缩写；**切入点只写一句方向，别把详解第一步抄一遍**；**同一题型在不同段里必须用同一个 name**，\`cards_build\` 靠它并题；卡里不要出现校名、人名、学号；JSON 里的 LaTeX 反斜杠双写（\`$\\\\sim$\`）。

## 排版注意（这几条踩过，写进去能省一次重编）

- \`**加粗**\` 别跨 \`$…$\`，加粗只写在纯文本段内，否则会原样印出星号
- 半栏卡里 \`$$…$$\` 一行只放一个式子，两个并排必超宽被裁；长式子用 \`\\begin{aligned}…\\end{aligned}\` 拆行
- 卡片 name 字段不要写 \`$…$\`，索引页会原样印出来，用 unicode 符号或纯文本
- 单卡正文（题干 + 证明）超过 620 字符会退化成整栏卡，尽量让卡的长度别跨在阈值两侧
- 尽量不用 section 分节，密集的参考卡直接连着排

## 覆盖记录（coverage.json）

不用手抄。跑 \`cards_coverage\`，它从 parts 里数出每页条目数并写盘，你只要声明 \`reviewed: "all"\`（或 \`1-71\` 这种范围）。数不对 \`cards_build\` 会拒绝编译。
`
}

function partsOf(target) {
  return String(target || '').split(/[\\/]+/).filter(Boolean)
}
