// 卡片工坊 · 浏览器半边
// 本机的目录选择器只编了 native 一种实现，客户端 listDirectory 一律被拒，
// 所以列目录走 Host 的 /card-workshop/api/*，选目录仍用原生对话框。
window.__ModuleLoader__.load({
  id: 'dsh-card-workshop',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PANEL = 'card-workshop'
    const API = '/card-workshop'
    const DEFAULT_ROOT = 'D:\\卡片库'

    const T = {
      zh: {
        title: '卡片工坊',
        intro: '选一份 PDF、选好归到哪个子文件夹，剩下的交给对话里的模型：逐页读、出定义卡、定理卡、题型卡。',
        root: '母文件夹',
        change: '选目录',
        target: '目标子文件夹',
        level1: '一级',
        level2: '二级',
        newFolder: '新建',
        newPlaceholder: '新文件夹名',
        create: '建',
        source: '源文件',
        pickDir: '选源目录',
        up: '上一层',
        addFile: '添加文件',
        fileHint: '或直接填 PDF 的绝对路径',
        preview: '任务单',
        start: '交给 AI',
        done: '已有产物',
        none: '还没有',
        manual: '手填',
        reload: '刷新',
        need: '母文件夹、子文件夹、源文件都要选。',
        missing: '（这个子文件夹还不存在）',
      },
      en: {
        title: 'Card workshop',
        intro: 'Pick a PDF and the subfolder it belongs in; the agent then reads it page by page and builds definition, theorem, and problem-type cards.',
        root: 'Library',
        change: 'Pick folder',
        target: 'Subfolder',
        level1: 'Level 1',
        level2: 'Level 2',
        newFolder: 'New',
        newPlaceholder: 'Folder name',
        create: 'Create',
        source: 'Source',
        pickDir: 'Pick folder',
        up: 'Up',
        addFile: 'Add file',
        fileHint: 'or paste the absolute PDF path',
        preview: 'Task',
        start: 'Send to AI',
        done: 'Outputs',
        none: 'None yet',
        manual: 'type',
        reload: 'Reload',
        need: 'Library, subfolder, and source are required.',
        missing: '(this subfolder does not exist yet)',
      },
    }

    const isPdf = (name) => /\.pdf$/i.test(String(name || ''))
    const join_ = (a, b) => String(a || '').replace(/[\\/]+$/, '') + '\\' + b
    const parentOf = (p) => String(p || '').replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')

    const Icon = (props) =>
      h('svg', { width: (props && props.size) || 18, height: (props && props.size) || 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round', strokeLinecap: 'round' },
        h('rect', { x: 6.5, y: 3, width: 13.5, height: 15, rx: 2 }),
        h('path', { d: 'M4 6.5v12A2.5 2.5 0 0 0 6.5 21h9' }),
        h('path', { d: 'M10 8h6.5M10 11.5h6.5M10 15h4' }))

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { err: null }
      }
      static getDerivedStateFromError(err) {
        return { err }
      }
      componentDidCatch(err, info) {
        console.error('[card-workshop] panel crashed', err, info)
      }
      render() {
        if (!this.state.err) return this.props.children
        const e = this.state.err
        return h('div', { style: { padding: 24, color: 'var(--dsw-alias-state-error-primary)', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12.5, whiteSpace: 'pre-wrap' } },
          '卡片工坊面板出错：\n' + String((e && e.message) || e) + '\n\n' + String((e && e.stack) || '').split('\n').slice(0, 8).join('\n'))
      }
    }

    function apply(ctx) {
      const lang = (() => {
        try {
          const snap = ctx.get('locale')?.getSnapshot()
          return snap && /^en/i.test(snap.active) ? 'en' : 'zh'
        } catch {
          return /^en\b/i.test(navigator.language) ? 'en' : 'zh'
        }
      })()
      const t = (k) => (T[lang] && T[lang][k]) || T.zh[k] || k

      const BOX = { border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 10, padding: '14px 16px' }
      const BTN = {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 8,
        padding: '6px 12px',
        font: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
      }
      const BTN_PRIMARY = { ...BTN, background: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)', color: '#fff', fontWeight: 600 }
      const INPUT = {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 8,
        padding: '6px 10px',
        font: 'inherit',
        fontSize: 13,
        minWidth: 0,
      }
      const CHIP = (active, dim) => ({
        ...BTN,
        padding: '5px 10px',
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        background: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
        borderColor: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)',
        color: active ? '#fff' : dim ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)',
      })
      const Label = (props) => h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8, letterSpacing: 0.2 } }, props.children)

      async function api(path, params) {
        const qs = params ? '?' + new URLSearchParams(params).toString() : ''
        const res = await fetch(API + path + qs, { headers: { accept: 'application/json' } })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      }

      function Panel() {
        const [root, setRoot] = React.useState(DEFAULT_ROOT)
        const [rootInput, setRootInput] = React.useState(DEFAULT_ROOT)
        const [levels, setLevels] = React.useState([])
        const [l1, setL1] = React.useState(null)
        const [l2, setL2] = React.useState(null)
        const [manualTarget, setManualTarget] = React.useState('')
        const [news, setNews] = React.useState('')
        const [srcDir, setSrcDir] = React.useState('')
        const [srcEntries, setSrcEntries] = React.useState([])
        const [picked, setPicked] = React.useState([])
        const [manualSrc, setManualSrc] = React.useState('')
        const [outputs, setOutputs] = React.useState([])
        const [targetExists, setTargetExists] = React.useState(null)
        const [error, setError] = React.useState('')
        const [diag, setDiag] = React.useState({ api: '连…', last: '还没调用', step: '挂载' })

        const target = manualTarget.trim() || (l1 ? (l2 ? l1 + '/' + l2 : l1) : '')

        const loadTree = React.useCallback(async (dir) => {
          setDiag((d) => ({ ...d, step: '列母文件夹' }))
          try {
            const r = await api('/api/tree', { root: dir })
            setDiag((d) => ({ ...d, api: '在', last: r.ok ? `母文件夹 ${r.levels.length} 个一级` : '读不到 ' + dir }))
            setLevels(r.ok ? r.levels : [])
          } catch (err) {
            setDiag((d) => ({ ...d, api: '断了', last: '接口失败：' + String((err && err.message) || err) }))
            setLevels([])
          }
        }, [])

        React.useEffect(() => {
          loadTree(root)
        }, [root, loadTree])

        React.useEffect(() => {
          if (!target) return setOutputs([])
          let live = true
          api('/api/list', { dir: join_(root, target.replace(/\//g, '\\')) })
            .then((r) => {
              if (!live) return
              setTargetExists(r.ok)
              setOutputs(r.ok ? r.entries.filter((e) => !e.dir && isPdf(e.name)).map((e) => e.name) : [])
            })
            .catch(() => live && setOutputs([]))
          return () => { live = false }
        }, [root, target])

        async function pickRoot() {
          try {
            const dir = await ctx.uiWorkspace.pickDirectory()
            if (!dir) return
            setRoot(dir)
            setRootInput(dir)
            setL1(null)
            setL2(null)
          } catch (err) {
            setError('选目录失败：' + String((err && err.message) || err))
          }
        }

        async function pickSource() {
          try {
            const dir = await ctx.uiWorkspace.pickDirectory()
            if (!dir) return
            await browse(dir)
          } catch (err) {
            setError('选目录失败：' + String((err && err.message) || err))
          }
        }

        async function browse(dir) {
          setSrcDir(dir)
          setDiag((d) => ({ ...d, step: '列源目录' }))
          try {
            const r = await api('/api/list', { dir })
            setSrcEntries(r.ok ? r.entries : [])
            setDiag((d) => ({ ...d, api: '在', last: r.ok ? `${dir} · ${r.entries.length} 条` : r.message }))
            if (!r.ok) setError(r.message)
          } catch (err) {
            setSrcEntries([])
            setDiag((d) => ({ ...d, api: '断了', last: String((err && err.message) || err) }))
          }
        }

        function clickSrcEntry(entry) {
          if (entry.dir) return browse(entry.path)
          if (!isPdf(entry.name)) return
          setPicked((prev) => (prev.includes(entry.path) ? prev.filter((x) => x !== entry.path) : prev.concat(entry.path)))
        }

        function addManualSource() {
          const p = manualSrc.trim().replace(/^["'“”]|["'“”]$/g, '').trim()
          if (!p) return
          if (!isPdf(p)) return setError('手动填的也得是 .pdf')
          setPicked((prev) => (prev.includes(p) ? prev : prev.concat(p)))
          setManualSrc('')
          setError('')
        }

        async function createSub() {
          const name = news.trim()
          if (!name) return
          setDiag((d) => ({ ...d, step: '新建子文件夹' }))
          try {
            const res = await fetch(API + '/api/mkdir', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ parent: l1 ? join_(root, l1) : root, name }),
            })
            const r = await res.json()
            if (!r.ok) return setError('新建失败：' + r.message)
            setNews('')
            if (l1) setL2(name)
            else setL1(name)
            await loadTree(root)
            setDiag((d) => ({ ...d, last: '新建 ' + r.path + (r.created ? '' : '（已存在）') }))
          } catch (err) {
            setError('新建失败：' + String((err && err.message) || err))
          }
        }

        const task = [
          '【卡片工坊】',
          '母文件夹：' + root,
          '目标子文件夹：' + (target || '（未选）'),
          '源文件：' + (picked.length ? picked.join('；') : '（未选）'),
          '',
          '按卡片工坊流程走：cards_prepare 拆页 → 读 .work/<批次>/plan.md 按段施工（一段读完立刻写 parts/NN.json）→ cards_check → cards_build。题型卡每题给切入点和完整详解，成品不写来源页码、不做核对表。开工前用任务清单把各段列上，全部做完挨个标完成，别留尾巴。',
        ].join('\n')

        function start() {
          if (!target || !picked.length) return setError(t('need'))
          try {
            ctx.uiWorkspace.startSession(undefined, { prompt: task, whenDraftExists: 'replace' })
          } catch (err) {
            setError(String((err && err.message) || err))
          }
        }

        const children = l1 && levels.find((l) => l.name === l1)?.children

        return h('div', { style: { height: '100%', overflow: 'auto', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' } },
          h('div', { style: { maxWidth: 1020, margin: '0 auto', padding: '20px 24px 64px' } },

            h('div', { style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '8px 10px', marginBottom: 16 } },
              h('div', null, '文件接口：' + diag.api),
              h('div', null, '最近一次：' + diag.last),
              h('div', null, '步骤：' + diag.step)),

            h('div', { style: { fontSize: 20, fontWeight: 650, marginBottom: 6 } }, t('title')),
            h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', marginBottom: 20, lineHeight: 1.7 } }, t('intro')),

            h('div', { style: { ...BOX, marginBottom: 14 } },
              h(Label, null, t('root')),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('input', { value: rootInput, onChange: (e) => setRootInput(e.target.value), style: { ...INPUT, flex: '1 1 420px', fontFamily: 'ui-monospace, Consolas, monospace' } }),
                h('button', { style: BTN, onClick: () => { setRoot(rootInput); setL1(null); setL2(null) } }, t('reload')),
                h('button', { style: BTN, onClick: pickRoot }, t('change')))),

            h('div', { style: { ...BOX, marginBottom: 14 } },
              h(Label, null, t('target') + (target ? '　→ ' + target + (targetExists === false ? ' ' + t('missing') : '') : '')),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 } },
                h('div', null,
                  h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 } }, t('level1')),
                  h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                    levels.length
                      ? levels.map((l) => h('button', { key: l.name, className: 'cw-chip', style: CHIP(l1 === l.name), onClick: () => { setL1(l.name); setL2(null); setManualTarget('') } }, l.name))
                      : h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '—'))),
                h('div', null,
                  h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 } }, t('level2')),
                  h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                    children && children.length
                      ? children.map((n) => h('button', { key: n, className: 'cw-chip', style: CHIP(l2 === n), onClick: () => { setL2(n); setManualTarget('') } }, n))
                      : h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, l1 ? '—' : t('target') + '…')))),
              h('div', { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
                h('input', { value: news, onChange: (e) => setNews(e.target.value), placeholder: t('newPlaceholder'), style: { ...INPUT, flex: '0 1 180px' } }),
                h('button', { style: BTN, disabled: !news.trim(), onClick: createSub }, t('create')),
                h('input', { value: manualTarget, onChange: (e) => setManualTarget(e.target.value), placeholder: t('manual') + '：高等数学/第一章 极限', style: { ...INPUT, flex: '1 1 260px' } }))),

            h('div', { style: { ...BOX, marginBottom: 14 } },
              h(Label, null, t('source')),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 } },
                h('button', { style: BTN, onClick: pickSource }, t('pickDir')),
                h('button', { style: BTN, onClick: () => srcDir && browse(parentOf(srcDir)), disabled: !srcDir }, t('up')),
                h('button', { style: BTN, onClick: () => browse(srcDir), disabled: !srcDir }, t('reload')),
                h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' } }, srcDir || '—')),
              h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 } },
                srcEntries.length
                  ? srcEntries.map((e) => h('button', {
                    key: e.path,
                    className: 'cw-chip',
                    title: e.path,
                    style: CHIP(picked.includes(e.path), e.dir),
                    onClick: () => clickSrcEntry(e),
                  }, (e.dir ? '📁 ' : '') + e.name))
                  : h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, srcDir ? '（空目录）' : '—')),
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('input', { value: manualSrc, onChange: (e) => setManualSrc(e.target.value), placeholder: t('fileHint'), style: { ...INPUT, flex: '1 1 380px', fontFamily: 'ui-monospace, Consolas, monospace' } }),
                h('button', { style: BTN, onClick: addManualSource }, t('addFile'))),
              picked.length
                ? h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 3 } },
                  picked.map((p) => h('div', { key: p, style: { fontSize: 12, fontFamily: 'ui-monospace, Consolas, monospace', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' } }, '✓ ' + p)))
                : null),

            h('div', { style: { ...BOX, marginBottom: 14 } },
              h(Label, null, t('preview')),
              h('pre', { style: { margin: 0, fontSize: 12, lineHeight: 1.65, whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-secondary)', fontFamily: 'ui-monospace, Consolas, monospace' } }, task),
              h('div', { style: { display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' } },
                h('button', { style: BTN_PRIMARY, onClick: start }, t('start')),
                error ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null)),

            h('div', { style: BOX },
              h(Label, null, t('done')),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, fontFamily: 'ui-monospace, Consolas, monospace', color: 'var(--dsw-alias-label-secondary)' } },
                outputs.length ? outputs.map((n) => h('div', { key: n }, n)) : h('div', null, t('none')))))
        )
      }

      function Guarded() {
        return h(Boundary, null, h(Panel))
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 44, label: () => T[lang].title }, Icon))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, Guarded))
    }

    return { inject: ['slots', 'uiWorkspace'], apply }
  },
})
