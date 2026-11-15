// 越界复检：不花模型 token，直接扫成品 PDF 或 deck 的文字层。
// 词表来源三层：课程里手填的 forbidden、后面章节标题里抽出来的词、内置的常见后续话题。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readdirSync, statSync } from 'node:fs'
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
  if (builtin) for (const w of BUILTIN) if (!allowed.includes(w)) words.add(w)
  return [...words]
}

// 逐页扫文字，返回命中的词和页码
export function scanPages(pages, words) {
  const hits = new Map()
  pages.forEach((text, i) => {
    const t = String(text || '')
    for (const w of words) {
      if (!w || !t.includes(w)) continue
      const rec = hits.get(w) || { word: w, pages: [], sample: '' }
      if (rec.pages.length < 6) rec.pages.push(i + 1)
      if (!rec.sample) {
        const at = t.indexOf(w)
        rec.sample = t.slice(Math.max(0, at - 24), at + w.length + 24).replace(/\s+/g, ' ').trim()
      }
      hits.set(w, rec)
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

export { basename }
