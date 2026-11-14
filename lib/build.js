// 把 deck.json 排成 LaTeX 卡片并编译成 PDF。
// 排版规则：定义卡/定理卡两栏流式（长的整栏），题型卡整栏可跨页。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { scanSensitive, sweepOldBatches } from './prepare.js'

const run = promisify(execFile)
const EXEC = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true }

const ESC = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&', '#': '\\#', '_': '\\_', '%': '\\%', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' }
const escText = (s) => String(s).replace(/[\\{}$&#_%~^]/g, (c) => ESC[c])
const inline = (s) => escText(s).replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}').replace(/`([^`]+)`/g, '\\texttt{$1}')

function textToTex(s) {
  const src = String(s ?? '')
  let out = ''
  let last = 0
  const re = /\$\$([^$]+?)\$\$|\$([^$\n]+?)\$/g
  let m
  while ((m = re.exec(src))) {
    out += inline(src.slice(last, m.index))
    out += m[1] != null ? '\\[' + m[1] + '\\]' : '$' + m[2] + '$'
    last = m.index + m[0].length
  }
  return out + inline(src.slice(last))
}

// 段落 + 简单列表（- 开头） + 每段之间留小间距
function blocks(s) {
  const lines = String(s ?? '').replace(/\r/g, '').split('\n')
  const out = []
  let buf = []
  let list = null
  const flushPar = () => {
    if (!buf.length) return
    const text = buf.join('\n').trim()
    buf = []
    if (text) out.push(textToTex(text))
  }
  const flushList = () => {
    if (!list) return
    out.push('\\begin{cwlist}\n' + list.map((t) => '\\item ' + textToTex(t)).join('\n') + '\n\\end{cwlist}')
    list = null
  }
  for (const line of lines) {
    const item = /^\s*[-·•]\s+(.*)$/.exec(line)
    if (item) {
      flushPar()
      ;(list = list || []).push(item[1])
      continue
    }
    flushList()
    if (!line.trim()) flushPar()
    else buf.push(line)
  }
  flushPar()
  flushList()
  return out.join('\n\n')
}

const PREAMBLE = String.raw`
\documentclass[10pt]{ctexart}
\usepackage[a4paper,top=13mm,bottom=14mm,left=11mm,right=11mm,footskip=7mm]{geometry}
\usepackage[most]{tcolorbox}
\usepackage{amsmath,amssymb}
\usepackage{xcolor}
\usepackage{enumitem}
\usepackage{longtable}
\usepackage{booktabs}
\usepackage{array}
\usepackage{fancyhdr}
\usepackage[hidelinks,bookmarks=true,bookmarksnumbered=false]{hyperref}
\usepackage{lastpage}
\usepackage{newunicodechar}

\definecolor{cwdef}{HTML}{2B64A8}
\definecolor{cwthm}{HTML}{2E7D32}
\definecolor{cwtype}{HTML}{C65D14}
\definecolor{cwink}{HTML}{3A3A3A}
\definecolor{cwsoft}{HTML}{7A7A7A}
\definecolor{cwline}{HTML}{D8D8D8}

\newunicodechar{×}{\ensuremath{\times}}
\newunicodechar{÷}{\ensuremath{\div}}
\newunicodechar{±}{\ensuremath{\pm}}
\newunicodechar{≤}{\ensuremath{\leq}}
\newunicodechar{≥}{\ensuremath{\geq}}
\newunicodechar{≠}{\ensuremath{\neq}}
\newunicodechar{≈}{\ensuremath{\approx}}
\newunicodechar{≡}{\ensuremath{\equiv}}
\newunicodechar{∞}{\ensuremath{\infty}}
\newunicodechar{∈}{\ensuremath{\in}}
\newunicodechar{∉}{\ensuremath{\notin}}
\newunicodechar{⊂}{\ensuremath{\subset}}
\newunicodechar{⊆}{\ensuremath{\subseteq}}
\newunicodechar{∪}{\ensuremath{\cup}}
\newunicodechar{∩}{\ensuremath{\cap}}
\newunicodechar{∅}{\ensuremath{\varnothing}}
\newunicodechar{∀}{\ensuremath{\forall}}
\newunicodechar{∃}{\ensuremath{\exists}}
\newunicodechar{→}{\ensuremath{\to}}
\newunicodechar{←}{\ensuremath{\leftarrow}}
\newunicodechar{⇒}{\ensuremath{\Rightarrow}}
\newunicodechar{⇔}{\ensuremath{\Leftrightarrow}}
\newunicodechar{↦}{\ensuremath{\mapsto}}
\newunicodechar{∑}{\ensuremath{\sum}}
\newunicodechar{∏}{\ensuremath{\prod}}
\newunicodechar{∫}{\ensuremath{\int}}
\newunicodechar{√}{\ensuremath{\sqrt{}}}
\newunicodechar{α}{\ensuremath{\alpha}}
\newunicodechar{β}{\ensuremath{\beta}}
\newunicodechar{γ}{\ensuremath{\gamma}}
\newunicodechar{δ}{\ensuremath{\delta}}
\newunicodechar{ε}{\ensuremath{\varepsilon}}
\newunicodechar{θ}{\ensuremath{\theta}}
\newunicodechar{λ}{\ensuremath{\lambda}}
\newunicodechar{μ}{\ensuremath{\mu}}
\newunicodechar{π}{\ensuremath{\pi}}
\newunicodechar{σ}{\ensuremath{\sigma}}
\newunicodechar{φ}{\ensuremath{\varphi}}
\newunicodechar{ω}{\ensuremath{\omega}}
\newunicodechar{Δ}{\ensuremath{\Delta}}
\newunicodechar{Σ}{\ensuremath{\Sigma}}
\newunicodechar{Ω}{\ensuremath{\Omega}}
\newunicodechar{′}{\ensuremath{'}}
\newunicodechar{⋯}{\ensuremath{\cdots}}
\newunicodechar{…}{\ensuremath{\ldots}}

\setlist[itemize]{leftmargin=4mm,itemsep=0.5mm,topsep=0.6mm,parsep=0mm}
\newlist{cwlist}{itemize}{1}
\setlist[cwlist]{label=\textcolor{cwsoft}{·},leftmargin=3.4mm,itemsep=0.4mm,topsep=0.6mm,parsep=0mm}

\pagestyle{fancy}
\fancyhf{}
\renewcommand{\headrulewidth}{0.3pt}
\fancyhead[L]{\footnotesize\sffamily\color{cwsoft}卡片工坊}
\fancyhead[R]{\footnotesize\sffamily\color{cwsoft}\cwhead}
\fancyfoot[L]{\footnotesize\sffamily\color{cwsoft}\cwfoot}
\fancyfoot[R]{\footnotesize\sffamily\color{cwsoft}\thepage\,/\,\pageref{LastPage}}

\newtcolorbox{cwcard}[2]{enhanced,breakable,arc=1.4mm,boxrule=0.6pt,
  colframe=#1,colback=white,colbacktitle=#1,coltitle=white,
  left=2.6mm,right=2.6mm,top=1.6mm,bottom=1.8mm,
  fonttitle=\sffamily\bfseries\small,title={#2},
  attach boxed title to top left={yshift=-0.2mm},
  boxed title style={arc=1mm,boxrule=0pt,left=1.6mm,right=1.6mm,top=0.7mm,bottom=0.7mm}}
\newtcolorbox{cwcardR}[2]{enhanced,arc=1.4mm,boxrule=0.6pt,
  colframe=#1,colback=white,colbacktitle=#1,coltitle=white,
  left=2.6mm,right=2.6mm,top=1.6mm,bottom=1.8mm,
  fonttitle=\sffamily\bfseries\small,title={#2},
  attach boxed title to top left={yshift=-0.2mm},
  boxed title style={arc=1mm,boxrule=0pt,left=1.6mm,right=1.6mm,top=0.7mm,bottom=0.7mm}}

\newcommand{\cwlab}[1]{\par\vspace{1.1mm}\noindent{\footnotesize\sffamily\color{cwsoft}#1}\enspace}
\newcommand{\cwprohead}[1]{\par\vspace{2.2mm}\noindent{\sffamily\bfseries #1}\enspace}
\newcommand{\cwsec}[1]{%
  \clearpage\thispagestyle{empty}\null\vfill
  {\centering{\sffamily\bfseries\LARGE\color{cwink}#1\par}\vspace{3mm}{\color{cwline}\rule{40mm}{0.6pt}\par}\vfill}}
\newcommand{\cwhead}{CARDWORK}
\newcommand{\cwfoot}{CARDWORK}
`

const prelude = (num) => `\\pdfbookmark[2]{${num}}{card:${num}}\\label{card:${num}}`

function defCard(d, i) {
  const num = d.id || `D-${String(i + 1).padStart(2, '0')}`
  const parts = []
  if (d.body) parts.push(blocks(d.body))
  if (d.notation) parts.push('\\cwlab{记号}' + blocks(d.notation))
  if (d.gist) parts.push('\\cwlab{要害}' + blocks(d.gist))
  if (d.usage) parts.push('\\cwlab{用法}' + blocks(d.usage))
  return { num, name: d.name || '', section: d.section, tex: prelude(num) + '\n' + parts.join('\n'), len: String(d.body || '').length }
}

function thmCard(t, i) {
  const num = t.id || `T-${String(i + 1).padStart(2, '0')}`
  const parts = []
  if (t.conditions) parts.push('\\cwlab{条件}' + blocks(t.conditions))
  if (t.conclusion) parts.push('\\cwlab{结论}' + blocks(t.conclusion))
  if (t.statement) parts.push(blocks(t.statement))
  if (t.proof) parts.push('\\par\\vspace{1.4mm}\\noindent{\\footnotesize\\sffamily\\color{cwsoft}证明}\\par\n' + blocks(t.proof))
  if (t.usage) parts.push('\\cwlab{用在}' + blocks(t.usage))
  return { num, name: t.name || '', section: t.section, tex: prelude(num) + '\n' + parts.join('\n'), len: String((t.statement || '') + (t.proof || '')).length }
}

function typeCard(t, i) {
  const num = t.id || `P-${String(i + 1).padStart(2, '0')}`
  const parts = []
  if (t.recognize) parts.push('\\cwlab{认题}' + blocks(t.recognize))
  if (t.method) parts.push('\\cwlab{通法}' + blocks(t.method))
  if (t.pitfalls) parts.push('\\cwlab{易错}' + blocks(t.pitfalls))
  const problems = Array.isArray(t.problems) ? t.problems : []
  if (problems.length) {
    parts.push('\\par\\vspace{2.2mm}\\noindent{\\footnotesize\\sffamily\\color{cwsoft}题目 ' + problems.length + ' 道}\\par')
    problems.forEach((p, pi) => {
      parts.push('\\cwprohead{题' + (pi + 1) + '}' + blocks(p.statement))
      if (p.key) parts.push('\\cwlab{切入点}' + blocks(p.key))
      if (p.solution) parts.push('\\cwlab{详解}' + blocks(p.solution))
    })
  }
  return { num, name: t.name || '', section: t.section, tex: prelude(num) + '\n' + parts.join('\n'), count: problems.length }
}

const LONG = 620

function layout(cards, color, { full = false } = {}) {
  const out = []
  let pair = []
  let section
  const flush = () => {
    if (!pair.length) return
    // 落单的一张走整栏，不然右边空半页
    out.push(pair.length === 1
      ? pair[0].split('cwcardR').join('cwcard')
      : '\\begin{tcbraster}[raster columns=2,raster equal height=rows,raster valign=top,raster column skip=2.4mm,raster row skip=2.4mm]\n' + pair.join('\n') + '\n\\end{tcbraster}')
    pair = []
  }
  for (const c of cards) {
    if (c.section && c.section !== section) {
      flush()
      out.push(`\\cwsec{${inline(c.section)}}`)
      section = c.section
    }
    if (full || c.len > LONG) {
      flush()
      out.push(`\\begin{cwcard}{${color}}{${c.title}}\n${c.tex}\n\\end{cwcard}`)
    } else {
      pair.push(`\\begin{cwcardR}{${color}}{${c.title}}\n${c.tex}\n\\end{cwcardR}`)
      if (pair.length === 2) flush()
    }
  }
  flush()
  return out.join('\n\n')
}

function titleOf(num, name) {
  return name ? `${num} · ${name}` : num
}

export function validate(deck, manifest, coverage) {
  const errors = []
  const defs = Array.isArray(deck.definitions) ? deck.definitions : []
  const thms = Array.isArray(deck.theorems) ? deck.theorems : []
  const types = Array.isArray(deck.types) ? deck.types : []
  const problems = types.flatMap((t) => (Array.isArray(t.problems) ? t.problems : []).map((p) => ({ ...p, type: t.name })))

  if (!defs.length && !thms.length && !problems.length) errors.push('deck 里一条内容都没有')

  const cov = Array.isArray(coverage) ? coverage : []
  const total = manifest.totalPages
  if (cov.length !== total) errors.push(`覆盖面 ${cov.length} 页，源文件 ${total} 页，对不上`)
  for (let p = 1; p <= total; p++) {
    const row = cov.find((c) => c.page === p)
    if (!row) errors.push(`第 ${p} 页没有覆盖记录`)
    else if (row.reviewed !== true) errors.push(`第 ${p} 页没标 reviewed`)
  }
  const sum = (key) => cov.reduce((n, c) => n + (Number(c[key]) || 0), 0)
  if (sum('definitions') !== defs.length) errors.push(`定义：覆盖记录 ${sum('definitions')} 条，deck ${defs.length} 张`)
  if (sum('theorems') !== thms.length) errors.push(`定理：覆盖记录 ${sum('theorems')} 条，deck ${thms.length} 张`)
  if (sum('problems') !== problems.length) errors.push(`题目：覆盖记录 ${sum('problems')} 道，deck ${problems.length} 道`)

  const ids = problems.map((p) => p.id).filter(Boolean)
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dup.length) errors.push('题目 id 重复：' + [...new Set(dup)].join('、'))

  for (const p of [...defs, ...thms, ...problems]) {
    const page = Number(p.page)
    if (!page) errors.push(`「${p.name || p.id || p.statement?.slice(0, 12)}」没写 page`)
    else if (page < 1 || page > total) errors.push(`「${p.name || p.id}」的 page=${page} 越界`)
  }

  const leaks = scanSensitive(JSON.stringify(deck))
  if (leaks.length) errors.push('deck 里还有敏感信息：' + leaks.map((l) => `${l.kind}×${l.count}`).join('、'))

  return { errors, counts: { definitions: defs.length, theorems: thms.length, types: types.length, problems: problems.length } }
}

export function render(deck) {
  const defs = (deck.definitions || []).map(defCard)
  const thms = (deck.theorems || []).map(thmCard)
  const types = (deck.types || []).map(typeCard)

  const index = []
  const rows = (list, label, width) =>
    list.map((c) => `${label} & ${inline(c.num)} & ${inline(c.name || '—')} & \\pageref{card:${c.num}} \\\\`).join('\n')

  index.push('{\\sffamily\\bfseries\\large 定义卡\\par}\\vspace{1mm}')
  index.push('\\begin{longtable}{@{}p{10mm}p{18mm}p{0.62\\linewidth}p{14mm}@{}}\\toprule 类 & 卡号 & 名称 & 页码 \\\\\\midrule\\endhead\n' + rows(defs, '定义') + '\n\\bottomrule\\end{longtable}')
  index.push('\\vspace{4mm}{\\sffamily\\bfseries\\large 定理卡\\par}\\vspace{1mm}')
  index.push('\\begin{longtable}{@{}p{10mm}p{18mm}p{0.62\\linewidth}p{14mm}@{}}\\toprule 类 & 卡号 & 名称 & 页码 \\\\\\midrule\\endhead\n' + rows(thms, '定理') + '\n\\bottomrule\\end{longtable}')
  const typeRows = types
    .map((c) => `题型 & ${inline(c.num)} & ${inline(c.name || '—')}（${c.count} 道） & \\pageref{card:${c.num}} \\\\`)
    .join('\n')
  index.push('\\vspace{4mm}{\\sffamily\\bfseries\\large 题型卡\\par}\\vspace{1mm}')
  index.push('\\begin{longtable}{@{}p{10mm}p{18mm}p{0.62\\linewidth}p{14mm}@{}}\\toprule 类 & 卡号 & 名称 & 页码 \\\\\\midrule\\endhead\n' + typeRows + '\n\\bottomrule\\end{longtable}')

  const body = []
  const defTex = layout(defs.map((c) => ({ ...c, title: titleOf(c.num, c.name) })), 'cwdef')
  const thmTex = layout(thms.map((c) => ({ ...c, title: titleOf(c.num, c.name) })), 'cwthm')
  const typeTex = layout(types.map((c) => ({ ...c, title: titleOf(c.num, c.name) })), 'cwtype', { full: true })

  const stats = `定义 ${defs.length} 条 · 定理 ${thms.length} 条 · 题型 ${types.length} 类 · 题目 ${types.reduce((n, t) => n + t.count, 0)} 道`
  const symbols = Array.isArray(deck.symbols) && deck.symbols.length
    ? `\\clearpage\n\\pdfbookmark[1]{符号约定}{symbols}\n{\\sffamily\\bfseries\\Large 符号约定}\\vspace{3mm}\\par\n\\begin{longtable}{@{}p{0.24\\linewidth}p{0.72\\linewidth}@{}}\\toprule 记号 & 含义 \\\\\\midrule\n${deck.symbols.map((s) => `${inline(s[0])} & ${inline(s[1])} \\\\`).join('\n')}\n\\bottomrule\\end{longtable}\n`
    : ''
  const date = new Date().toLocaleDateString('zh-CN')

  return String.raw`${PREAMBLE.replace('\\newcommand{\\cwhead}{CARDWORK}', () => `\\newcommand{\\cwhead}{${inline(deck.title || '')}}`).replace('\\newcommand{\\cwfoot}{CARDWORK}', () => `\\newcommand{\\cwfoot}{${inline(deck.subtitle || '卡片工坊')}}`)}
\begin{document}
\thispagestyle{empty}
\null\vfill
{\centering
{\sffamily\bfseries\huge\color{cwink}${inline(deck.title || '卡片集')}\par}\vspace{4mm}
{\sffamily\large\color{cwsoft}${inline(deck.subtitle || '')}\par}\vspace{6mm}
{\color{cwline}\rule{60mm}{0.6pt}\par}\vspace{6mm}
{\sffamily\color{cwink}${stats}\par}\vspace{2mm}
{\sffamily\small\color{cwsoft}${date}\par}}
\vfill

\clearpage
\pdfbookmark[1]{索引}{index}
{\sffamily\bfseries\Large 索引}\vspace{3mm}\par
${index.join('\n\n\\vspace{2mm}\n')}

${symbols}
\clearpage
\pdfbookmark[1]{定义卡}{defs}
${defTex}

\clearpage
\pdfbookmark[1]{定理卡}{thms}
${thmTex}

\clearpage
\pdfbookmark[1]{题型卡}{types}
${typeTex}

\clearpage
\thispagestyle{empty}\null\vfill
{\centering\sffamily\small\color{cwsoft}卡片工坊 · ${date} · ${stats}\par}
\end{document}
`
}

export function prepareWork(workdir, deckPath, coveragePath) {
  const deckFile = deckPath && existsSync(deckPath) ? deckPath : join(workdir, 'deck.json')
  let deck
  if (existsSync(deckFile)) deck = JSON.parse(readFileSync(deckFile, 'utf8'))
  else {
    const merged = mergeParts(join(workdir, 'parts'))
    if (!merged) throw new Error('既没有 deck.json，也没有 parts/*.json')
    deck = merged
  }
  const coverage = coveragePath && existsSync(coveragePath) ? JSON.parse(readFileSync(coveragePath, 'utf8')) : null
  const manifest = JSON.parse(readFileSync(join(workdir, 'manifest.json'), 'utf8'))
  return { deck, coverage, manifest }
}

// 分片写：每批一个小 json，合并与重新编号都在这里做，模型不用碰大文件
export function mergeParts(dir) {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  if (!files.length) return null
  const deck = { title: '', subtitle: '', definitions: [], theorems: [], types: [], symbols: [] }
  for (const f of files) {
    let part
    try {
      part = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch (e) {
      throw new Error(`分片 ${f} 不是合法 JSON：${e.message}`)
    }
    if (part.title && !deck.title) deck.title = part.title
    if (part.subtitle && !deck.subtitle) deck.subtitle = part.subtitle
    if (Array.isArray(part.symbols)) deck.symbols.push(...part.symbols)
    deck.definitions.push(...(part.definitions || []))
    deck.theorems.push(...(part.theorems || []))
    for (const t of part.types || []) {
      const hit = t.name ? deck.types.find((x) => x.name === t.name) : null
      if (hit) hit.problems = (hit.problems || []).concat(t.problems || [])
      else deck.types.push({ ...t, problems: [...(t.problems || [])] })
    }
  }
  renumber(deck)
  return deck
}

function renumber(deck) {
  const pad = (n) => String(n).padStart(2, '0')
  deck.definitions.forEach((d, i) => {
    d.id = `D-${pad(i + 1)}`
  })
  deck.theorems.forEach((t, i) => {
    t.id = `T-${pad(i + 1)}`
  })
  deck.types.forEach((t, i) => {
    t.id = `P-${pad(i + 1)}`
    ;(t.problems || []).forEach((p, j) => {
      p.id = `p${i + 1}-${j + 1}`
    })
  })
}

// 只报结论，不让模型回头重读原文
export function checkDeck({ root, batch, deckPath, coveragePath }) {
  const work = join(root, '.work', batch)
  if (!existsSync(work)) return { ok: false, message: '没有这个批次：' + batch }
  const { deck, coverage, manifest } = prepareWork(work, deckPath || join(work, 'deck.json'), coveragePath || join(work, 'coverage.json'))
  const check = validate(deck, manifest, coverage)
  const warnings = []
  const problems = (deck.types || []).flatMap((t) => (t.problems || []).map((p) => ({ ...p, type: t.name })))
  const norm = (s) => String(s || '').replace(/[\s$\\{}/]/g, '').replace(/[，。、；：,.;:！？!?]/g, '').slice(0, 40)
  const seen = new Map()
  for (const p of problems) {
    const k = norm(p.statement)
    if (!k) {
      warnings.push('有一道题题干是空的')
      continue
    }
    if (seen.has(k)) warnings.push(`题干重复：第 ${seen.get(k)} 页与第 ${p.page} 页`)
    else seen.set(k, p.page)
  }
  const emptyPages = (coverage || []).filter((c) => !c.definitions && !c.theorems && !c.problems).map((c) => c.page)
  if (emptyPages.length) warnings.push(`这些页一条都没抽到（封面/空白页正常）：${emptyPages.join('、')}`)
  return {
    ok: !check.errors.length,
    pages: manifest.totalPages,
    counts: check.counts,
    errors: check.errors.slice(0, 8),
    warnings: warnings.slice(0, 8),
  }
}

export async function compile(tex, workdir) {
  const texFile = join(workdir, 'deck.tex')
  writeFileSync(texFile, tex, 'utf8')
  mkdirSync(join(workdir, 'out'), { recursive: true })
  let log = ''
  for (let pass = 0; pass < 3; pass++) {
    try {
      await run('xelatex', ['-interaction=nonstopmode', '-halt-on-error', '-output-directory=' + join(workdir, 'out'), texFile], { ...EXEC, timeout: 180000 })
    } catch (err) {
      log = String(err.stdout || '') + String(err.stderr || '')
      try {
        const lines = readFileSync(join(workdir, 'out', 'deck.log'), 'utf8').split('\n')
        const bad = lines.map((l, i) => ({ l, i })).filter((x) => /^!|^l\.\d+|Error|Undefined|Missing/.test(x.l)).slice(0, 4)
        log = bad.map((x) => x.l).join('\n') || log
      } catch {}
      return { ok: false, log }
    }
  }
  const pdf = join(workdir, 'out', 'deck.pdf')
  return existsSync(pdf) ? { ok: true, pdf } : { ok: false, log: '没生成 PDF' }
}

// coverage 是机械活：每页抽到几条，从 parts 数出来就行，模型只负责声明「这些页我都看过」
export function writeCoverage({ root, batch, reviewed = 'all' }) {
  const work = join(root, '.work', batch)
  if (!existsSync(work)) return { ok: false, message: '没有这个批次：' + batch }
  const manifest = JSON.parse(readFileSync(join(work, 'manifest.json'), 'utf8'))
  const deck = (existsSync(join(work, 'deck.json')) ? JSON.parse(readFileSync(join(work, 'deck.json'), 'utf8')) : mergeParts(join(work, 'parts'))) || {
    definitions: [],
    theorems: [],
    types: [],
  }
  const total = manifest.totalPages
  const flags = parseReviewed(reviewed, total)
  if (!flags) return { ok: false, message: `reviewed 写法看不懂：${reviewed}，用 all 或 1-71 或 1,3-7` }

  const rows = []
  for (let p = 1; p <= total; p++) rows.push({ page: p, definitions: 0, theorems: 0, problems: 0, reviewed: flags })
  const at = (page) => rows[Number(page) - 1]
  for (const d of deck.definitions || []) if (at(d.page)) at(d.page).definitions++
  for (const t of deck.theorems || []) if (at(t.page)) at(t.page).theorems++
  for (const t of deck.types || []) for (const p of t.problems || []) if (at(p.page)) at(p.page).problems++

  writeFileSync(join(work, 'coverage.json'), JSON.stringify(rows, null, 2), 'utf8')
  const empty = rows.filter((r) => !r.definitions && !r.theorems && !r.problems).map((r) => r.page)
  return {
    ok: true,
    pages: total,
    reviewed: flags ? '全部' : '部分',
    counts: {
      definitions: rows.reduce((n, r) => n + r.definitions, 0),
      theorems: rows.reduce((n, r) => n + r.theorems, 0),
      problems: rows.reduce((n, r) => n + r.problems, 0),
    },
    empty,
  }
}

function parseReviewed(spec, total) {
  if (!spec || spec === 'all') return true
  const ok = new RegExp(`^[\\d,\\-\\s]+$`).test(String(spec))
  if (!ok) return null
  const set = new Set()
  for (const part of String(spec).split(',')) {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(part.trim())
    if (m) {
      for (let i = Number(m[1]); i <= Number(m[2]); i++) set.add(i)
    } else if (/^\d+$/.test(part.trim())) set.add(Number(part))
  }
  return set.size >= total ? true : null
}

export async function build({ root, batch, deckPath, coveragePath, keepWork = false, keepVersions = false }) {
  const work = join(root, '.work', batch)
  if (!existsSync(work)) return { ok: false, message: '没有这个批次：' + batch }
  const { deck, coverage, manifest } = prepareWork(work, deckPath || join(work, 'deck.json'), coveragePath || join(work, 'coverage.json'))
  const check = validate(deck, manifest, coverage)
  if (check.errors.length) return { ok: false, message: '校验没过', errors: check.errors }

  const tex = render({ ...deck, title: deck.title || manifest.target.join(' / ') })
  const built = await compile(tex, work)
  if (!built.ok) return { ok: false, message: 'LaTeX 没编过', log: built.log }

  const targetPath = manifest.targetPath
  mkdirSync(targetPath, { recursive: true })
  const base = manifest.target[manifest.target.length - 1]
  const stampOfBatch = (/^(\d{8}-\d{6})/.exec(manifest.batch) || [])[1] || nowStamp()
  // 一个批次只对应一份成品：重编就盖掉同一名字，keepVersions 才另起序号
  let out
  if (keepVersions) {
    const prefix = `${base}-${stampOfBatch}-`
    const used = readdirSync(targetPath).filter((f) => f.startsWith(prefix) && f.endsWith('.pdf')).length
    out = join(targetPath, `${prefix}${String(used + 1).padStart(2, '0')}.pdf`)
  } else {
    out = join(targetPath, `${base}-${stampOfBatch}.pdf`)
  }
  copyFileSync(built.pdf, out)

  const pages = await pageCount(out)
  if (!keepWork) rmSync(work, { recursive: true, force: true })
  // 顺手把放久了没人管的旧批次清掉，免得 .work 越堆越大
  const swept = sweepOldBatches(root, 12, [batch])
  return { ok: true, pdf: out, pages, counts: check.counts, work: keepWork ? work : null, swept }
}

function nowStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function pageCount(pdf) {
  try {
    const { stdout } = await run('pdfinfo', [pdf], EXEC)
    const m = /^Pages:\s+(\d+)/m.exec(stdout)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}
