// 抽取准备：把源 PDF 拆成逐页文字 + 按需页图，顺手把敏感信息换掉。
// 文字层能抠到的东西在这里就脱敏，模型看到的是替换后的版本。
// 省钱的三处：空格压掉一半、正文按 10 页一段合并成 md、页图只给需要的页出。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { readCourse, scopeCutoff, scopeText } from './course.js'
import { scopeWords } from './audit.js'

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

// 公式密集的页：文字层会把分式矩阵拍平，提示模型去看图
function denseMath(text) {
  const t = String(text)
  const sym = (t.match(/[√∫∑∞→≤≥±×÷∀∃≈≠∂∈⊂∪∩αβγδεθλμσφωπ]/g) || []).length
  const digits = (t.match(/\d/g) || []).length
  return sym >= 6 || (t.length > 100 && digits / t.length > 0.18)
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
      dense: denseMath(compact),
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
      .map((p) => `### p.${p.n}${p.scanned ? '（扫描页，没有文字层）' : p.dense && textUsable ? '（公式密集，建议 cards_page_image 核一遍）' : ''}\n${readFileSync(p.text, 'utf8').trim() || '（空）'}`)
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
  const course = readCourse(root, partsOf(target)[0])
  const courseCoarse = course.found && !(course.chapters || []).some((c) => /^§?\s*\d+\.\d+\.\d+/.test(String(c).trim()))
  // 范围是「生成那一刻」的，跟成品一起存下来，以后复检按当时的口径算
  const cut = course.found ? scopeCutoff(course) : null
  manifest.scope = course.found
    ? {
      textbook: course.textbook,
      chapter: (course.current || {}).chapter || '',
      section: (course.current || {}).section || '',
      cutoff: cut.idx,
      allowed: cut.chapters.slice(0, cut.idx),
      words: scopeWords(course),
      text: scopeText(course),
      at: manifest.createdAt,
    }
    : null
  writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  const planFile = join(work, 'plan.md')
  writeFileSync(planFile, buildPlan(manifest, partList, course), 'utf8')
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
    course: {
      found: course.found,
      subject: partsOf(target)[0],
      textbook: course.textbook,
      file: course.file,
      last: course.found ? `${course.current?.chapter || ''}${course.current?.section ? ' · ' + course.current.section : ''}` : '',
      scope: scopeText(course),
      coarse: courseCoarse,
      confirmNeeded: true,
    },
    sources: sourcesInfo,
    redactions: manifest.redactions,
  }
}

// 一段一条的施工单：怎么读、写到哪、格式长什么样，都写在这儿，省得每次在对话里复述
function buildPlan(manifest, partList, course) {
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

  const subject = (manifest.target || [''])[0] || ''
  const lastScope = course.found ? `${course.current?.chapter || ''}${course.current?.section ? ' · ' + course.current.section : ''}` : ''
  const chapters = Array.isArray(course.chapters) ? course.chapters : []
  const hasSub = chapters.some((c) => /^§?\s*\d+\.\d+\.\d+/.test(String(c).trim()))
  const coarse = course.found && !hasSub

  const confirmBlock = coarse
    ? `## 先把目录补全（现在就做，别拖到拆页之后）

这个科目的目录只到「§x.y」这一级，没有 x.y.z 小目。先上网查全、贴给用户核对，再用 \`cards_course set\` 覆盖 \`chapters\`，然后回来问范围。

目录粗一级，判断就会错一片——§2.3 里藏着 2.3.1 微分中值定理、2.3.2 L'Hospital、2.3.3 Taylor定理，目录里没这三行的话，「泰勒」「洛必达」都会被当成越界。`
    : `## 先确认知识范围（每份文件都要问一次）

按顺序来，别跳步：

1. 问教材：书名、作者、版次、出版社。用户之前给过就不用重问。
2. 上网查目录。查到之后**把章节标题贴给用户核对**，尤其这次要用的那一章，把 §x.y 和 x.y.z 小目录都列出来。查不到就让用户贴一份。
3. 问这次做到哪一节、哪一小目，例如「§2.3.3 Taylor定理」。范围就是它及其之前。
4. 用 \`cards_course set\` 写进去：\`chapters\` 平铺到 **x.y.z** 这一级，\`source\` 填网址或「用户贴的」。
5. **范围确认完，紧接着问一句「这份文件想叫什么名字」**，让用户自己打字。收到之后原样传给 \`cards_build\` 的 \`fileName\`（不带 .pdf）；用户说「随便」「你定」才用默认命名。名字会印在成品文件名和页眉上，别自己编一个替用户决定。

${course.found ? `上次记的是「${lastScope || '（没写）'}」，这次照样要按 1—5 再确认一遍，别直接沿用。` : '这个科目还没有课程文件，从第 1 步开始。'}`

  const scopeBlock = course.found
    ? `## 知识范围（硬规则）

${scopeText(course)}

**详解里只许用上面这些章节已经出现的定义和定理，加高中代数、三角基础。** 想用范围外的方法，先把它作为一张定义卡或定理卡收进 deck——收进来才算「本章学过」。`
    : `## 知识范围（还没设）

等用户确认教材和章节后，调 \`cards_course\` 写入：

\`\`\`json
{"action":"set","subject":"${subject}","textbook":"《工科数学分析（上册）》潮小李 李慧玲 周吴杰 高教社 2022","chapters":["第一章 一元函数的极限与连续","§1.1 实数集及其完备性","§1.2 数列极限","§1.3 函数极限","§1.4 无穷小量与无穷大量","§1.5 函数的连续性","第二章 一元函数微分学及其应用","§2.1 导数","§2.2 微分","§2.3 微分学基本定理及其应用","2.3.1 微分中值定理","2.3.2 L'Hospital法则","2.3.3 Taylor定理","§2.4 函数性态的研究"],"current":{"chapter":"第二章 一元函数微分学及其应用","section":"§2.3.2 L'Hospital法则"},"forbidden":[],"source":"https://mall.hep.com.cn/goods-40566.html"}
\`\`\`

写完之后，这次就按「该章节及之前」的知识点写详解。用户没说教材，别自己编一个；网上查到的目录必须让用户核对过才算数。`

  return `# 卡片工坊 · 批次 ${manifest.batch}

目标文件夹：${manifest.targetPath}
共 ${manifest.totalPages} 页，分 ${partList.length} 段，每段 ${manifest.chunk} 页。

${confirmBlock}

${scopeBlock}

## 怎么干

1. ${howRead}
2. 一段读完立刻把条目写进 \`parts/${'NN'}.json\`，别攒着，写一段丢一段。写完不要复述内容，直接下一段。
3. 已经读过的段不要回头再读；改哪条就只写哪条。这份 plan.md 读一次就够，别每段都翻。
4. 全部写完直接 \`cards_build\`，带上 \`reviewed:"all"\`——它自己汇总覆盖记录，顺便做结构体检（裸 LaTeX、缺证明、题型拆重、题没详解这类），过了就出 PDF，没过就把问题列出来。重编要带 keepWork:true，不然批次目录会被删。
   体检里还有一条「第 N 页原文有 X 道带编号的题，卡片只收了 Y 题」，那是按原文每页的题号数跟卡片对账，看到就回去补，别当噪声。
5. \`cards_build\` 只报某一张卡出错时，只改那个 part 里对应的一条，别整段重写。
6. 开工时按段建一份任务清单，全部写完、PDF 出好之后把每条标完成——清单不会自己消失，留到最后会挂在会话里。
7. 成品确认没问题后跑 \`cards_cleanup\` 把这一批的中间产物清掉；重编期间别跑。放超过 12 小时没人动的批次，下次 \`cards_prepare\` 或 \`cards_build\` 会自动清。
8. 每份成品旁边会留 \`<成品名>.deck.json\` 和 \`.manifest.json\`，是结构快照。以后改文案、补字段、换版式，直接改 deck.json 再跑 \`cards_rebuild\`，不用重读 PDF。

## 段表

| 段 | 页 | 文字 | 页图 |
|---|---|---|---|
${rows.join('\n')}

## 条目格式（parts/NN.json）

\`\`\`json
{"definitions":[{"page":12,"name":"函数在一点的极限","body":"原文定义，公式用 $…$","notation":"$\\\\lim f(x)=A$","gist":"最容易读漏的那个词","usage":"一句用法"}],"theorems":[{"page":13,"name":"单调有界准则","conditions":"…","conclusion":"…","proof":"…","usage":"…"}],"types":[{"name":"数列极限的四则运算","recognize":"整类怎么认出来","idea":"整类为什么这么想，通法的来由","pitfalls":"整类最容易错在哪","problems":[{"page":14,"statement":"完整题干","identify":"这一道为什么属于本类","idea":"2—4 句：看到什么特征、为什么走这条路、放弃的那条为什么不走","steps":["第一步…（依据）","第二步…（依据）","结论"],"answer":"最终答案，一行，$…$ 包公式"}]}]}
\`\`\`

要点：**紧凑写，别缩进**；\`page\` 必填（全局页号）；题干照原文，证明不缩写；**题型卡是「识别 / 思路 / 易错」三段，每题是「识别 / 思路 / 步骤」三段**，没有「切入点」这个字段了；步骤至少 3 行，每行末尾标依据（用了哪条定理、哪个等价）；**每题必须写 \`answer\`（最终答案一行）**；**同一题型在不同段里必须用同一个 name**，\`cards_build\` 靠它并题；卡里不要出现校名、人名、学号；JSON 里的 LaTeX 反斜杠双写。

## 复算：写完步骤要独立再算一遍

每道题的步骤写完，**先不看自己写的步骤**，只拿题干重新算一遍，把结果写进 \`answer\`：

- 算出来跟步骤最后一行一致 → 直接写 \`answer\`，收工
- 不一致 → 先怀疑步骤，逐行回头查；查完确认步骤没错，再改 \`answer\` 并在 \`identify\` 里补一句为什么最终结论是这个

复算是唯一能抓住「符号都对但推导错了」的关卡。别跳——你写步骤时脑子里那条路已经走顺了，不看步骤重算才会走岔。

## 排版注意（这几条踩过，写进去能省一次重编）

- \`**加粗**\` 别跨 \`$…$\`，加粗只写在纯文本段内，否则会原样印出星号
- 半栏卡里 \`$$…$$\` 一行只放一个式子，两个并排必超宽被裁；长式子用 \`\\begin{aligned}…\\end{aligned}\` 拆行
- 卡片 name 字段不要写 \`$…$\`，索引页会原样印出来，用 unicode 符号或纯文本
- 单卡正文（题干 + 证明）超过 620 字符会退化成整栏卡，尽量让卡的长度别跨在阈值两侧
- 尽量不用 section 分节，密集的参考卡直接连着排

## 覆盖记录（coverage.json）

不用手抄。\`cards_build\` 带 \`reviewed:"all"\` 会自己汇总，也可以单跑 \`cards_coverage\`。
`
}

function partsOf(target) {
  return String(target || '').split(/[\\/]+/).filter(Boolean)
}
