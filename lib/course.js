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

// 把「第几章第几节之前」翻成一句可执行的约束
export function scopeText(course) {
  if (!course || !course.found) return ''
  const chapters = Array.isArray(course.chapters) ? course.chapters : []
  const cur = course.current || {}
  const idx = typeof cur.chapter === 'number' ? cur.chapter : chapters.findIndex((c) => String(c) === String(cur.chapter)) + 1
  if (!idx || idx < 1) {
    return `参考教材：${course.textbook || '（没写）'}\n本次范围：${cur.chapter || '（没写）'}——这一章不在章节列表里，核对一下章节名是不是写错了`
  }
  const allowed = chapters.slice(0, idx)
  const lines = []
  lines.push(`参考教材：${course.textbook || '（没写）'}`)
  lines.push(`本次范围：${cur.chapter || allowed[allowed.length - 1] || ''}${cur.section ? ' · ' + cur.section : ''}`)
  lines.push(`可用范围：${allowed.map((c, i) => (i === idx - 1 && cur.section ? `${c}（到 ${cur.section}）` : c)).join('、')}，以及高中代数、三角基础`)
  if (Array.isArray(course.forbidden) && course.forbidden.length) lines.push(`还不许用：${course.forbidden.join('、')}`)
  return lines.join('\n')
}
