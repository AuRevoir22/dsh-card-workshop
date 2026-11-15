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

const SECTION_NO = /§\s*(\d+(?:\.\d+)*)/

function sectionOf(text) {
  const m = SECTION_NO.exec(String(text || ''))
  return m ? m[1] : ''
}

// 条目是不是在描述某一章（按 § 编号或标题本身）
export function chapterMatches(chapter, text) {
  const a = sectionOf(chapter)
  const b = sectionOf(text)
  if (a && b) return a === b
  const title = String(chapter || '').replace(SECTION_NO, '').trim()
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
