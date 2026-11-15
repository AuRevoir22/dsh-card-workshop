// 科目级的教材与进度：<母文件夹>/<科目>/课程.json
// 一级目录就是科目名。首次生成某个科目时要先问用户教材，再问做到哪一章哪一节。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const COURSE_FILE = '课程.json'

export function coursePath(root, subject) {
  return join(root, String(subject || '').trim(), COURSE_FILE)
}

export function readCourse(root, subject) {
  const file = coursePath(root, subject)
  if (!subject) return { found: false, reason: '没给科目名（一级目录）' }
  if (!existsSync(file)) return { found: false, file }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return { found: true, file, ...data }
  } catch (e) {
    return { found: false, file, reason: '课程.json 读不出来：' + e.message }
  }
}

export function writeCourse(root, subject, data) {
  const file = coursePath(root, subject)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  return file
}

const SECTION_NO = /^§?\s*(\d+(?:\.\d+)*)/

function sectionOf(text) {
  const m = SECTION_NO.exec(String(text || '').trim())
  return m ? m[1] : ''
}

function numParts(n) {
  return String(n).split('.').map((x) => Number(x))
}

function cmpNum(a, b) {
  const x = numParts(a)
  const y = numParts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d) return d
  }
  return 0
}

// 写进课程文件前先体检一遍：顺序、深度、current 能不能对上
export function validateCourse(data) {
  const errors = []
  const warnings = []
  const chapters = Array.isArray(data.chapters) ? data.chapters.filter((c) => String(c).trim()) : []
  if (!chapters.length) errors.push('chapters 是空的，先把教材目录放进去')
  if (chapters.length) {
    const nums = chapters.map(sectionOf).filter(Boolean)
    for (let i = 1; i < nums.length; i++) {
      if (cmpNum(nums[i - 1], nums[i]) >= 0) {
        errors.push(`目录顺序不对：「${chapters[i - 1]}」后面跟了「${chapters[i]}」`)
        break
      }
    }
    const hasSub = chapters.some((c) => /^§?\s*\d+\.\d+\.\d+/.test(String(c).trim()))
    if (!hasSub) warnings.push('目录只到「§x.y」这一级，建议补到「x.y.z」小目录——不然像「泰勒」「洛必达」这种藏在 §2.3 里的内容会被当成越界')
    const cur = data.current || {}
    const target = String(cur.section || cur.chapter || '').trim()
    if (!target) errors.push('current 里要有 chapter 或 section')
    else {
      const hit = chapters.some((c) => chapterMatches(c, target) || String(c).includes(target))
      if (!hit) {
        const near = chapters.filter((c) => String(c).includes(target.slice(0, 4)) || target.includes(sectionOf(c))).slice(0, 5)
        errors.push(`current 的「${target}」在目录里找不到${near.length ? '，最接近的是：' + near.join(' / ') : ''}`)
      }
    }
  }
  if (!data.textbook) warnings.push('没写教材名')
  if (!data.source) warnings.push('没记目录来源（网址或「用户贴的」），以后没法追溯')
  return { errors, warnings }
}

function courseValid(data) {
  return validateCourse(data).errors.length === 0
}

// 条目是不是在描述某一章（按 § 编号或标题本身）
export function chapterMatches(chapter, text) {
  const a = sectionOf(chapter)
  const b = sectionOf(text)
  if (a && b) return a === b
  const title = String(chapter || '').replace(/^§?\s*\d+(?:\.\d+)*\s*/, '').trim()
  if (!title || title.length < 3) return false
  return String(text || '').includes(title)
}

// 可用到第几章为止：先看 current 定到节，再让 forbidden 里「§x 及之后」往下压
export function scopeCutoff(course) {
  const chapters = Array.isArray(course.chapters) ? course.chapters : []
  const cur = course.current || {}
  let idx = 0
  if (cur.section) {
    const i = chapters.findIndex((c) => chapterMatches(c, cur.section))
    if (i >= 0) idx = i + 1
  }
  if (!idx && cur.chapter) {
    idx = typeof cur.chapter === 'number' ? cur.chapter : chapters.findIndex((c) => chapterMatches(c, cur.chapter) || String(c) === String(cur.chapter)) + 1
  }
  if (!idx || idx < 1) idx = chapters.length
  for (const f of course.forbidden || []) {
    const i = chapters.findIndex((c) => chapterMatches(c, f))
    if (i >= 0 && i + 1 < idx) idx = i + 1
  }
  return { idx, chapters }
}

export function scopeText(course) {
  if (!course || !course.found) return ''
  const { idx, chapters } = scopeCutoff(course)
  const cur = course.current || {}
  if (!chapters.length) {
    return `参考教材：${course.textbook || '（没写）'}\n本次范围：${cur.chapter || '（没写）'}——章节目录是空的，先补一份`
  }
  if (!idx || idx < 1) {
    return `参考教材：${course.textbook || '（没写）'}\n本次范围：${cur.chapter || '（没写）'}——这一章不在章节列表里，核对一下章节名是不是写错了`
  }
  const allowed = chapters.slice(0, idx)
  const lines = []
  lines.push(`参考教材：${course.textbook || '（没写）'}`)
  lines.push(`本次范围：${cur.chapter || ''}${cur.section ? ' · ' + cur.section : ''}`)
  lines.push(`可用范围：${allowed.map((c, i) => (i === idx - 1 && cur.section ? `${c}（到 ${cur.section}）` : c)).join('、')}，以及高中代数、三角基础`)
  const literal = (course.forbidden || []).filter((f) => !chapters.some((c) => chapterMatches(c, f)))
  if (literal.length) lines.push(`还不许用：${literal.join('、')}`)
  return lines.join('\n')
}
