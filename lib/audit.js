// 越界复检：不花模型 token，直接扫成品 PDF 或 deck 的文字层。
// 词表来源三层：课程里手填的 forbidden、后面章节标题里抽出来的词、内置的常见后续话题。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readCourse, scopeCutoff } from './course.js'

const run = promisify(execFile)
const EXEC = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }

// 各教材顺序不同，所以内置表只做兜底，命中后措辞是「疑似」而不是「一定」
const BUILTIN = [
  '定积分', '不定积分', '原函数', '二重积分', '三重积分', '重积分',
  '曲线积分', '曲面积分', '级数', '幂级数', '傅里叶', '微分方程',
  '偏导数', '偏导', '全微分', '方向导数', '梯度', '泰勒', '麦克劳林',
  '洛必达', '中值定理', '向量', '矩阵', '行列式', '特征值',
]

// 教材常用英文名，跟中文词表对不上就会误报，这里补一张对照
const ALIAS = {
  泰勒: ['Taylor', 'taylor'],
  麦克劳林: ['Maclaurin', 'maclaurin'],
  洛必达: ["L'Hospital", 'L’Hospital', 'LHospital', 'L Hospital', "L'Hôpital"],
  中值定理: ['均值定理'],
  罗尔: ['Rolle'],
  拉格朗日: ['Lagrange'],
  柯西: ['Cauchy'],
}

// 有的词是另一个词的子话题，父话题在范围内，它就在范围内
const IMPLIES = { 麦克劳林: '泰勒', 佩亚诺: '泰勒', 皮亚诺: '泰勒' }

function allowedHas(allowedText, word) {
  if (allowedText.includes(word)) return true
  const aliases = ALIAS[word]
  if (Array.isArray(aliases) && aliases.some((a) => allowedText.includes(a))) return true
  const parent = IMPLIES[word]
  return parent ? allowedHas(allowedText, parent) : false
}

function stripNoise(word) {
  return String(word || '')
    .replace(/^§\s*\d+(?:\.\d+)*\s*/, '')
    .replace(/^第[一二三四五六七八九十百\d]+[章节讲部分篇]\s*/, '')
    .replace(/及之后的一切.*$/, '')
    .replace(/(及其|的应用|的应用举例).*$/, '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[\s、，,。：:]/g, '')
    .trim()
}

// 允许范围内出现过的词不算越界（比如「夹逼」在数列极限这章）
function allowedBlob(course) {
  const { idx, chapters } = scopeCutoff(course)
  const cur = course.current || {}
  const allowed = idx > 0 ? chapters.slice(0, idx) : chapters
  return allowed.join(' ') + ' ' + (cur.section || '') + ' ' + (Array.isArray(course.accept) ? course.accept.join(' ') : '')
}

export function scopeWords(course, { builtin = false } = {}) {
  const words = new Set()
  const allowed = allowedBlob(course)
  const { idx, chapters } = scopeCutoff(course)
  // 手填的禁用语：能匹配到某一章的当范围用，匹配不到的就当字面词
  for (const w of course.forbidden || []) {
    const hit = chapters.some((c) => String(w || '').includes(String(c || '').replace(/^§\s*\d+(\.\d+)*\s*/, '').trim()) && String(c || '').trim().length > 3)
    if (hit) continue
    const s = stripNoise(w)
    if (s.length >= 2 && s.length <= 24) words.add(s)
  }
  // 后面章节的标题和里面的小节名，本身就该是禁用词
  if (idx > 0) {
    for (const c of chapters.slice(idx)) {
      const s = stripNoise(c)
      if (s.length >= 2) words.add(s)
    }
  }
  if (builtin) for (const w of BUILTIN) if (!allowedHas(allowed, w)) words.add(w)
  return [...words]
}

// 逐页扫文字，返回命中的词、页码和它的来源（确定/疑似）
export function scanPages(pages, entries) {
  const hits = new Map()
  pages.forEach((text, i) => {
    const t = String(text || '')
    for (const e of entries) {
      const word = typeof e === 'string' ? e : e.word
      const kind = typeof e === 'string' ? 'chapter' : e.kind || 'chapter'
      if (!word || !t.includes(word)) continue
      const rec = hits.get(word) || { word, kind, pages: [], sample: '' }
      if (rec.pages.length < 6) rec.pages.push(i + 1)
      if (!rec.sample) {
        const at = t.indexOf(word)
        rec.sample = t.slice(Math.max(0, at - 24), at + word.length + 24).replace(/\s+/g, ' ').trim()
      }
      hits.set(word, rec)
    }
  })
  return [...hits.values()].sort((a, b) => b.pages.length - a.pages.length)
}

export async function pdfPages(pdf) {
  const { stdout } = await run('pdftotext', ['-enc', 'UTF-8', '-layout', pdf, '-'], EXEC)
  const parts = stdout.split('\f')
  if (parts.length && parts[parts.length - 1].trim() === '') parts.pop()
  return parts
}

// 从路径往上找科目目录名，再读课程设置
export function courseForPath(root, file) {
  const rel = file.startsWith(root) ? file.slice(root.length + 1) : file
  const subject = rel.split(/[\\/]/)[0] || ''
  return { subject, course: readCourse(root, subject) }
}

export function collectPdfs(path) {
  if (!existsSync(path)) return []
  if (statSync(path).isFile()) return path.toLowerCase().endsWith('.pdf') ? [path] : []
  const out = []
  for (const d of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, d.name)
    if (d.isDirectory()) out.push(...collectPdfs(p))
    else if (d.name.toLowerCase().endsWith('.pdf')) out.push(p)
  }
  return out
}

// 成品旁边如果留着 manifest 快照，就用「生成那一刻」的范围，不按今天的课程设置算
export function scopeFromSnapshot(pdf) {
  const man = pdf.replace(/\.pdf$/i, '') + '.manifest.json'
  if (!existsSync(man)) return null
  try {
    const m = JSON.parse(readFileSync(man, 'utf8'))
    return m.scope && Array.isArray(m.scope.words) ? m.scope : null
  } catch {
    return null
  }
}

export async function auditFile(root, pdf, { forbidden = [], builtin = true, until, accept = [] } = {}) {
  const snap = scopeFromSnapshot(pdf)
  const { subject, course } = courseForPath(root, pdf)
  const entries = []
  let label = '未设范围'
  let from = 'current'

  const addBuiltin = (allowedText) => {
    if (!builtin) return
    for (const w of BUILTIN) if (!allowedHas(allowedText, w)) entries.push({ word: w, kind: 'builtin' })
  }

  if (snap) {
    from = 'snapshot'
    label = `${snap.chapter || ''}${snap.section ? ' · ' + snap.section : ''}`.trim() || '快照里没写范围'
    for (const w of snap.words) entries.push({ word: w, kind: 'chapter' })
    addBuiltin((snap.allowed || []).join(' '))
  } else if (until) {
    // 老文件没有快照，按用户给的口径重建范围，不看现在课程里那串禁用词
    const chapters = Array.isArray(course.chapters) ? course.chapters : []
    const { idx } = scopeCutoff({ chapters, current: { section: until }, forbidden: [] })
    label = until
    from = 'override'
    for (const c of chapters.slice(idx)) {
      const s = stripNoise(c)
      if (s.length >= 2) entries.push({ word: s, kind: 'chapter' })
    }
    addBuiltin(chapters.slice(0, idx).join(' '))
  } else {
    const base = course.found ? { ...course } : {}
    for (const w of scopeWords(base, {})) entries.push({ word: w, kind: 'chapter' })
    addBuiltin(allowedBlob(base))
    const cur = base.current || {}
    label = `${cur.chapter || ''}${cur.section ? ' · ' + cur.section : ''}`.trim() || '未设范围'
  }

  for (const w of forbidden) if (w) entries.push({ word: String(w), kind: 'manual' })
  const skip = new Set(accept.map((x) => String(x)))
  const pages = await pdfPages(pdf)
  return { name: basename(pdf), subject: course.found ? subject : '', scope: label, from, hits: scanPages(pages, entries.filter((e) => !skip.has(e.word))) }
}

export { basename }
