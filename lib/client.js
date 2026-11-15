/**
 * SideTeX 浏览器半边：左侧源码 + 右侧 PDF 的 LaTeX 工作台。
 *
 * 方法：右侧栏注册一个原生 tab（ctx.sidebarRightTabs + sidebar.right.pane.tab），
 *      左右分栏（可拖分隔条）：左栏在「源码」与「改动」之间切换，右栏是 pdf.js
 *      渲染的 PDF。PDF 单击 -> synctex 反查源码行并在左栏高亮滚动；左栏点行 ->
 *      synctex 正查在 PDF 上滚动并闪框。改动审阅只做**源码 diff**：逐 hunk
 *      接受 / 放弃 / 评论 / 撤销，不再构建基线 PDF。
 * 对象：一个会话里的 LaTeX 项目。
 */
window.__ModuleLoader__.load({
  id: 'dsh-side-tex',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const CLIENT_VERSION = 'v0.4.1'
    const TAB_ID = 'dsh-side-tex:latex'
    const TAB_KIND = 'latex'
    const MAX_PAGES = 24
    const MAX_LINES = 3000
    /** 一条批注最多引用的行数与字符数（超出截断，避免把整段/整页灌进对话）。 */
    const QUOTE_MAX_LINES = 40
    const QUOTE_MAX_CHARS = 3000
    /** 程序员常用等宽字体栈（不打包字体，本机没装自动回落）。 */
    const CODE_FONTS = {
      auto: "'JetBrains Mono','Cascadia Code','Fira Code','SF Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace",
      jetbrains: "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
      fira: "'Fira Code','Cascadia Code',ui-monospace,Consolas,monospace",
      cascadia: "'Cascadia Code','Cascadia Mono',Consolas,ui-monospace,monospace",
      consolas: "Consolas,'Courier New',ui-monospace,monospace",
    }
    /** 字体在选项里的显示名。 */
    const CODE_FONT_NAMES = {
      auto: 'JetBrains Mono / Cascadia Code',
      jetbrains: 'JetBrains Mono',
      fira: 'Fira Code',
      cascadia: 'Cascadia Code',
      consolas: 'Consolas',
    }
    const CODE_SIZE_MIN = 10
    const CODE_SIZE_MAX = 20
    const DEFAULT_CODE_FONT = 'auto'
    const DEFAULT_CODE_SIZE = 12
    const DRAG_MIN = 6
    const PREF_KEY = 'dsh-side-tex:ui'

    const STRINGS = {
      zh: {
        tabTitle: 'SideTeX',
        tabDesc: '左源码右 PDF，双向定位，逐处审阅源码改动',
        compile: '编译',
        compiling: '编译中…',
        auto: '自动',
        engine: '引擎',
        mainFile: '主文件',
        fullscreen: '放大面板',
        srcTab: '源码',
        diffTab: '改动',
        layoutSplit: '分栏',
        layoutSource: '源码',
        layoutPdf: 'PDF',
        reviewChip: '审阅',
        noProject: '这个目录里没有检测到 LaTeX 主文件。',
        noToolchain: '未找到 TeX 工具链（需要 latexmk）。请安装 TeX Live 或 MiKTeX。',
        openHint: '在项目里放一个含 \\documentclass 的 .tex，或在上方选择主文件。',
        noPdf: '还没有 PDF 产物。',
        noChanges: '没有待审阅的改动。',
        accept: '接受',
        reject: '放弃',
        comment: '评论',
        undo: '撤销',
        acceptAll: '全部接受',
        rejectAll: '全部放弃',
        rejectConfirm: '放弃这处改动并恢复原版内容？',
        rejectAllConfirm: '放弃本文件的全部改动并恢复原版？',
        commentHint: '评论会写入对话，改动保留',
        sourceDiff: '源码差异',
        notes: '条批注',
        sendNotes: '发送到对话',
        clearNotes: '清空',
        addNote: '加入任务',
        cancel: '取消',
        deleteNote: '删除',
        notePlaceholder: '写下你的批注，例如：这段太啰嗦，压缩成两句',
        noAnchor: '未定位到源码',
        syncOff: '该位置没有 synctex 记录，先编译一次再试',
        sent: '已写入对话输入框',
        copied: '已复制到剪贴板',
        emptyNote: '批注为空',
        page: '页',
        line: '行',
        emptyTray: '单击源码行编辑、双击定位、Shift+单击选一段；点击 PDF 定位源码、拖框批注多行',
        pdfHint: '点击定位到源码；拖框选中多行写批注',
        annotateHint: '批注模式：单击就地开批注框；拖框也行',
        annotateToggle: '批注模式',
        saved: '已保存，PDF 刷新中…',
        annotateLine: '批注此行',
        annotateRange: '批注选区',
        resolvingRange: '正在解析选区对应的源码行…',
        rangeLines: '%n 行',
        quoteTitle: '原文',
        pickRange: '选区覆盖多个文件，点一个确定锚点',
        crossPage: '选区跨页，锚点取第一页',
        clearSel: '清除选区',
        shiftHint: 'Shift+单击选一段',
        annotate: '批注',
        loadingSource: '正在读取源码…',
        truncated: '仅显示前 %n 行',
        hunkAt: '第 %n 处',
        additions: '新增',
        deletions: '删除',
        conflict: '文件在此期间被改动，已刷新',
        jumpSource: '在源码中定位',
        noFile: '未选择文件',
        openMain: '打开主文件',
        fitWidth: '适合宽度',
        codeStyle: '代码样式',
        codeFont: '字体',
        fontAuto: '自动',
        fontSize: '字号',
        wrap: '自动换行',
        wrapHint: '换行后行号对齐首行；关闭则横向滚动',
        locate: '定位到 PDF',
      },
      en: {
        tabTitle: 'SideTeX',
        tabDesc: 'Source left, PDF right, bidirectional jump, per-hunk source review',
        compile: 'Compile',
        compiling: 'Compiling…',
        auto: 'Auto',
        engine: 'Engine',
        mainFile: 'Main file',
        fullscreen: 'Expand panel',
        srcTab: 'Source',
        diffTab: 'Changes',
        layoutSplit: 'Split',
        layoutSource: 'Source',
        layoutPdf: 'PDF',
        reviewChip: 'Review',
        noProject: 'No LaTeX main file detected in this directory.',
        noToolchain: 'No TeX toolchain found (latexmk required). Install TeX Live or MiKTeX.',
        openHint: 'Add a .tex with \\documentclass, or pick the main file above.',
        noPdf: 'No PDF yet.',
        noChanges: 'Nothing to review.',
        accept: 'Accept',
        reject: 'Reject',
        comment: 'Comment',
        undo: 'Undo',
        acceptAll: 'Accept all',
        rejectAll: 'Reject all',
        rejectConfirm: 'Reject this change and restore the accepted text?',
        rejectAllConfirm: 'Reject all changes in this file?',
        commentHint: 'The comment goes to the chat; the change stays',
        sourceDiff: 'Source diff',
        notes: 'notes',
        sendNotes: 'Send to chat',
        clearNotes: 'Clear',
        addNote: 'Add to task',
        cancel: 'Cancel',
        deleteNote: 'Delete',
        notePlaceholder: 'Write your note, e.g. shorten this to two sentences',
        noAnchor: 'Source not located',
        syncOff: 'No synctex record there; compile once and try again',
        sent: 'Inserted into the composer',
        copied: 'Copied to clipboard',
        emptyNote: 'Empty note',
        page: 'page',
        line: 'line',
        emptyTray: 'Click a line to edit, double-click to locate, Shift+click to select a range; click the PDF to jump back, drag a box to annotate lines',
        pdfHint: 'Click to locate in source; drag a box to annotate a range',
        annotateHint: 'Annotate mode: click to place a note box, or drag a box',
        annotateToggle: 'Annotate mode',
        saved: 'Saved, refreshing PDF…',
        annotateLine: 'Annotate line',
        annotateRange: 'Annotate selection',
        resolvingRange: 'Resolving the selected lines…',
        rangeLines: '%n lines',
        quoteTitle: 'Source',
        pickRange: 'The box covers several files; pick one anchor',
        crossPage: 'The selection spans pages; anchoring on the first page',
        clearSel: 'Clear selection',
        shiftHint: 'Shift+click to select a range',
        annotate: 'Annotate',
        loadingSource: 'Reading source…',
        truncated: 'first %n lines only',
        hunkAt: 'change %n',
        additions: 'added',
        deletions: 'removed',
        conflict: 'The file changed meanwhile; refreshed',
        jumpSource: 'Locate in source',
        noFile: 'No file selected',
        openMain: 'Open main file',
        fitWidth: 'Fit width',
        codeStyle: 'Code style',
        codeFont: 'Font',
        fontAuto: 'Auto',
        fontSize: 'Size',
        wrap: 'Wrap',
        wrapHint: 'Wrapped lines align under the first line; turn off for horizontal scroll',
        locate: 'Locate in PDF',
      },
    }

    let locale = 'zh'
    try {
      locale = String(navigator.language ?? 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    } catch {
      locale = 'zh'
    }
    const T = (key) => (STRINGS[locale] ?? STRINGS.en)[key] ?? STRINGS.en[key] ?? key
    const fmt = (text, n) => String(text).replace('%n', String(n))

    const apiUrl = (method) => new URL(`dsh-latex/api/${method}`, document.baseURI).href
    const pdfUrl = (sessionId, rev, which) =>
      new URL(
        `dsh-latex/pdf?sessionId=${encodeURIComponent(sessionId)}&which=${which}${rev ? `&rev=${encodeURIComponent(rev)}` : ''}`,
        document.baseURI,
      ).href
    const vendorUrl = (name) => new URL(`dsh-latex/vendor/${name}`, document.baseURI).href
    const baseName = (path) => String(path ?? '').split('/').pop()

    async function call(method, payload, signal) {
      const response = await fetch(apiUrl(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal,
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok || body === null || body.ok !== true) {
        const error = new Error(body?.error?.message ?? `HTTP ${response.status}`)
        error.code = body?.error?.code
        throw error
      }
      return body.value
    }

    /** 读取持久化的界面偏好（不可用时静默）。 */
    function readPref(key, fallback) {
      try {
        const raw = window.localStorage.getItem(PREF_KEY)
        const parsed = raw === null ? {} : JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' && parsed[key] !== undefined ? parsed[key] : fallback
      } catch {
        return fallback
      }
    }

    /** 写入界面偏好。 */
    function writePref(key, value) {
      try {
        const raw = window.localStorage.getItem(PREF_KEY)
        const parsed = raw === null ? {} : JSON.parse(raw)
        const next = parsed !== null && typeof parsed === 'object' ? parsed : {}
        next[key] = value
        window.localStorage.setItem(PREF_KEY, JSON.stringify(next))
      } catch {
        // 隐私模式等忽略
      }
    }

    let pdfjsPromise = null
    async function loadPdfjs() {
      if (pdfjsPromise === null) {
        pdfjsPromise = import(vendorUrl('pdf.mjs')).then((mod) => {
          try {
            mod.GlobalWorkerOptions.workerSrc = vendorUrl('pdf.worker.mjs')
          } catch {
            // 旧版本
          }
          return mod
        })
      }
      return pdfjsPromise
    }

    async function openPdfDocument(pdfjs, data) {
      const options = {
        data,
        isEvalSupported: false,
        cMapUrl: vendorUrl('cmaps/'),
        cMapPacked: true,
        standardFontDataUrl: vendorUrl('standard_fonts/'),
      }
      try {
        return await pdfjs.getDocument(options).promise
      } catch (firstError) {
        try {
          const response = await fetch(vendorUrl('pdf.worker.mjs'))
          if (!response.ok) throw firstError
          const text = await response.text()
          pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
          return await pdfjs.getDocument(options).promise
        } catch {
          throw firstError
        }
      }
    }

    /** 安全销毁 pdf.js 文档：不同版本的 destroy 是异步的，也可能不存在。 */
    function destroyDoc(doc) {
      try {
        if (doc === null || doc === undefined) return
        if (typeof doc.destroy !== 'function') return
        const result = doc.destroy()
        if (result !== null && result !== undefined && typeof result.catch === 'function') result.catch(() => {})
      } catch {
        // 释放失败不影响界面
      }
    }

    /** 错误边界：单个渲染错误只让本面板显示错误，而不是整块黑屏。 */
    class PaneBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
        this.retry = () => this.setState({ error: null })
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        try {
          console.error('[side-tex] panel crashed:', error)
        } catch {
          // 忽略
        }
      }

      render() {
        if (this.state.error !== null) {
          return h('div', { className: 'blx-empty' },
            h('div', { className: 'blx-err' }, `LaTeX 面板出错：${this.state.error?.message ?? String(this.state.error)}`),
            h('div', { style: { marginTop: '8px' } },
              h('button', { type: 'button', className: 'blx-btn', onClick: this.retry }, '重试')))
        }
        return this.props.children
      }
    }

    /** 带错误边界的面板入口。 */
    function LatexTabSafe(props) {
      return h(PaneBoundary, null, h(LatexTab, props))
    }

    // ── 基础组件 ─────────────────────────────────────────────────────
    function Icon(props) {
      const size = props?.size ?? 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M6 2.5h7.2L18 7.3V21a.9.9 0 0 1-.9.9H6a.9.9 0 0 1-.9-.9V3.4A.9.9 0 0 1 6 2.5Z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M13 2.7V7a.8.8 0 0 0 .8.8h4.1', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M8.8 12.6h4M8.8 15.6h6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    /** 分段控件（源码 / 改动、分栏 / 源码 / PDF）。 */
    function Seg(props) {
      const { value, options, onChange } = props
      return h(
        'div',
        { className: 'blx-tabs', role: 'tablist' },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              role: 'tab',
              className: 'blx-tab',
              'data-active': String(value === option.value),
              title: option.title ?? option.label,
              onClick: () => onChange(option.value),
            },
            option.label,
          ),
        ),
      )
    }

    const CSS = `
.blx-root{--blx-blue:#2f6df6;--blx-blue-hi:#3b78ff;--blx-add:#2ea043;--blx-del:#f85149;--blx-code-size:12px;--blx-code-font:'JetBrains Mono','Cascadia Code','Fira Code','SF Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;--blx-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;color-scheme:dark;overflow:hidden}
.blx-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 8px;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-layer-1));border-bottom:1px solid var(--dsw-alias-border-l1)}
.blx-bar-sub{padding-top:0}
.blx-srccfg{gap:8px;flex-wrap:wrap;padding-top:4px;padding-bottom:6px;border-top:1px dashed var(--dsw-alias-border-l1)}
.blx-srccfg .blx-badge{font-family:var(--blx-mono)}
.blx-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-width:0}
.blx-grow{flex:1 1 auto;min-width:0}
.blx-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1,#23252b);color:var(--dsw-alias-label-primary,#e6e6e6);border-radius:7px;padding:3px 9px;font-size:11.5px;line-height:18px;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease,color .12s ease}
.blx-btn:hover{background:var(--dsw-alias-bg-layer-2,#2c2f37);border-color:#4a4e58}
.blx-btn:disabled{opacity:.45;cursor:default}
.blx-btn[data-variant="primary"]{border-color:var(--blx-blue);background:var(--blx-blue);color:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.blx-btn[data-variant="primary"]:hover{background:var(--blx-blue-hi);border-color:var(--blx-blue-hi)}
.blx-btn[data-variant="soft"]{background:rgba(47,109,246,.14);border-color:rgba(47,109,246,.5);color:#9db4ff}
.blx-btn[data-variant="ok"]{background:rgba(46,160,67,.14);border-color:rgba(46,160,67,.5);color:#7ee787}
.blx-btn[data-variant="ok"]:hover{background:rgba(46,160,67,.26)}
.blx-btn[data-variant="no"]{background:rgba(248,81,73,.12);border-color:rgba(248,81,73,.5);color:#ff938a}
.blx-btn[data-variant="no"]:hover{background:rgba(248,81,73,.24)}
.blx-btn[data-active="true"]{border-color:var(--blx-blue);color:#9db4ff}
.blx-sel{appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:2px 6px;font-size:11.5px;max-width:132px;color-scheme:dark;background-color:var(--dsw-alias-bg-layer-1,#23252b);color:var(--dsw-alias-label-primary,#e6e6e6)}
.blx-sel option{background-color:#23252b;color:#e6e6e6}
.blx-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.blx-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:0 0 auto}
.blx-dot[data-state="ok"]{background:var(--dsw-alias-state-success-primary)}
.blx-dot[data-state="error"],.blx-dot[data-state="timeout"]{background:var(--dsw-alias-state-error-primary)}
.blx-dot[data-state="compiling"]{background:var(--dsw-alias-state-warn-primary);animation:blx-pulse 1s ease-in-out infinite}
@keyframes blx-pulse{50%{opacity:.35}}
.blx-tabs{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#2a2d34);flex:0 0 auto}
.blx-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;padding:2px 9px;border-radius:6px;cursor:pointer;white-space:nowrap}
.blx-tab:hover{color:var(--dsw-alias-label-primary)}
.blx-tab[data-active="true"]{background:var(--blx-blue);color:#fff}
.blx-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:row;align-items:stretch}
.blx-pane{display:flex;flex-direction:column;min-width:0;min-height:0;flex:1 1 0;background:var(--dsw-alias-bg-base)}
.blx-pane-left{flex:0 0 46%}
.blx-divider{flex:0 0 5px;position:relative;cursor:col-resize;background:transparent;touch-action:none}
.blx-divider::after{content:"";position:absolute;top:0;bottom:0;left:2px;right:2px;border-radius:2px;background:var(--dsw-alias-border-l1);opacity:.7;transition:background .12s ease,opacity .12s ease}
.blx-divider:hover::after,.blx-divider[data-drag="true"]::after{background:var(--blx-blue);opacity:1}
.blx-pane-head{display:flex;gap:6px;align-items:center;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1,#26282e);flex:0 0 auto;min-width:0}
.blx-pane-title{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.blx-path{font-family:var(--blx-mono);font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;direction:rtl;text-align:left}
.blx-code-wrap{flex:1 1 auto;min-height:0;overflow:auto;background:var(--dsw-alias-bg-base)}
.blx-code{display:flex;flex-direction:column;min-width:0;width:100%;padding:6px 0 28px}
.blx-code[data-wrap="off"]{min-width:max-content;width:auto}
.blx-cl{display:flex;align-items:flex-start;min-height:calc(var(--blx-code-size) * 1.6 + 2px);line-height:1.6;font-family:var(--blx-code-font);font-size:var(--blx-code-size);font-variant-ligatures:none;white-space:pre;cursor:pointer}
.blx-cl:hover{background:rgba(127,127,127,.10)}
.blx-cl[data-chg="add"]{background:rgba(46,160,67,.13);box-shadow:inset 2px 0 0 var(--blx-add)}
/* 选区高亮（Shift+单击 / PDF 拖框解析出的行区间）；active 的行仍以 active 样式为准 */
.blx-cl[data-sel="true"]{background:rgba(47,109,246,.13);box-shadow:inset 2px 0 0 rgba(47,109,246,.55)}
.blx-cl[data-active="true"]{background:rgba(47,109,246,.22);box-shadow:inset 2px 0 0 var(--blx-blue)}
.blx-ln{flex:0 0 auto;min-width:2.8em;text-align:right;padding-right:8px;color:#5d6470;user-select:none}
.blx-cl[data-active="true"] .blx-ln{color:#9db4ff}
.blx-plus{flex:0 0 16px;width:16px;text-align:center;color:var(--blx-blue);opacity:0;font-weight:600;cursor:pointer}
.blx-cl:hover .blx-plus{opacity:.9}
.blx-plus:hover{opacity:1;text-shadow:0 0 6px rgba(47,109,246,.8)}
.blx-code-text{flex:1 1 auto;min-width:0;padding-right:12px;color:var(--dsw-alias-label-primary,#d7d9de)}
.blx-code[data-wrap="on"] .blx-code-text{white-space:pre-wrap;overflow-wrap:anywhere}
.blx-cl[data-editing="true"]{background:rgba(47,109,246,.10);cursor:text}
.blx-edit-loc{flex:0 0 auto;align-self:flex-start;margin-right:6px;padding:0 6px;line-height:inherit}
.blx-edit{flex:1 1 auto;min-width:0;box-sizing:border-box;margin-right:8px;padding:0 4px;border:1px solid var(--blx-blue);border-radius:4px;background:rgba(47,109,246,.10);color:var(--dsw-alias-label-primary,#d7d9de);font:inherit;line-height:inherit;resize:none;overflow:hidden;outline:none;min-height:calc(var(--blx-code-size) * 1.6 + 2px)}
.blx-empty{padding:22px 16px;color:var(--dsw-alias-label-secondary);line-height:1.75}
.blx-note2{color:var(--dsw-alias-label-secondary);font-size:11px;padding:2px 8px}
.blx-dim{color:var(--dsw-alias-label-secondary)}
.blx-mono{font-family:var(--blx-mono)}
.blx-err{color:var(--dsw-alias-state-error-primary)}
.blx-pdf{flex:1 1 auto;min-height:0;overflow:auto;padding:8px;background:var(--dsw-alias-bg-layer-2,#202227)}
.blx-pdf-hint{flex:0 0 auto;padding:3px 8px;border-top:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.blx-pages{display:flex;flex-direction:column;align-items:center;gap:10px}
.blx-page{position:relative;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.35);border-radius:3px;overflow:hidden;touch-action:none;cursor:crosshair}
.blx-page[data-annotate="true"]{cursor:copy;outline:2px solid var(--blx-blue);outline-offset:-2px}
.blx-page canvas{display:block;pointer-events:none}
.blx-page{user-select:none}
.blx-note{position:absolute;border:1.5px solid var(--blx-blue);background:rgba(47,109,246,.15);border-radius:3px;cursor:pointer}
.blx-note[data-active="true"]{background:rgba(47,109,246,.28);box-shadow:0 0 0 1px var(--blx-blue)}
.blx-pulse{position:absolute;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;border:1.5px solid var(--blx-blue);background:rgba(47,109,246,.18);pointer-events:none;animation:blx-pulse .55s ease-out forwards}
@keyframes blx-pulse{from{transform:scale(.4);opacity:.9}to{transform:scale(1.6);opacity:0}}
.blx-draft{position:absolute;border:1.5px dashed var(--blx-blue);background:rgba(47,109,246,.13);border-radius:3px;pointer-events:none}
.blx-flash{position:absolute;border:1.6px solid var(--blx-blue);background:rgba(47,109,246,.22);border-radius:3px;pointer-events:none;box-shadow:0 0 0 3px rgba(47,109,246,.16);animation:blx-pop .28s ease-out}
@keyframes blx-pop{from{transform:scale(1.04);opacity:.4}to{transform:scale(1);opacity:1}}
.blx-tray{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1);padding:6px 8px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-layer-1))}
.blx-draftbox{border:1px solid var(--blx-blue);border-radius:10px;box-shadow:0 8px 26px rgba(0,0,0,.4);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2));padding:8px;display:flex;flex-direction:column;gap:6px}
.blx-draftbox textarea,.blx-comment textarea{width:100%;box-sizing:border-box;min-height:56px;resize:vertical;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;padding:7px 8px}
.blx-draft-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.blx-selchips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.blx-quotebox>summary{cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary);list-style:none}
.blx-quotebox>summary::-webkit-details-marker{display:none}
.blx-quote{font-family:var(--blx-mono);font-size:11px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;max-height:96px;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 6px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.blx-chips{display:flex;gap:6px;flex-wrap:wrap;max-height:88px;overflow:auto}
.blx-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:2px 8px;font-size:11px;cursor:pointer;background:var(--dsw-alias-bg-layer-2,#2a2d34)}
.blx-chip:hover{border-color:var(--blx-blue)}
.blx-chip-id{font-family:var(--blx-mono);font-size:10px;color:#9db4ff}
.blx-mini{color:var(--dsw-alias-label-secondary);max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.blx-diff{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column}
.blx-files{display:flex;gap:6px;overflow-x:auto;padding:6px 8px 0;flex:0 0 auto}
.blx-filechip{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1,#23252b);color:var(--dsw-alias-label-primary);border-radius:999px;padding:2px 9px;font-size:11px;cursor:pointer;white-space:nowrap;display:inline-flex;gap:6px;align-items:center;max-width:240px}
.blx-filechip[data-active="true"]{border-color:var(--blx-blue);background:rgba(47,109,246,.16)}
.blx-filechip-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.blx-filechip-count{font-size:10px;color:var(--dsw-alias-label-secondary);font-family:var(--blx-mono)}
.blx-diff-actions{display:flex;gap:6px;align-items:center;padding:6px 8px;flex:0 0 auto;flex-wrap:wrap}
.blx-diff-actions .blx-btn{padding:2px 8px}
.blx-hunks{display:flex;flex-direction:column;gap:10px;padding:2px 8px 14px}
.blx-hunk{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#26282e);box-shadow:0 1px 3px rgba(0,0,0,.14)}
.blx-hunk-head{display:flex;gap:6px;align-items:center;padding:5px 8px;background:var(--dsw-alias-bg-layer-2,#2c2f37);flex-wrap:wrap}
.blx-hunk-range{font-family:var(--blx-mono);font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.blx-hunk-body{overflow-x:auto}
/* 改动面板也支持自动换行：换行后取消横向滚动，正文列可收缩并按词折行，行号/符号列固定 */
.blx-diff[data-wrap="on"] .blx-hunk-body{overflow-x:hidden}
.blx-dl{display:flex;align-items:flex-start;min-height:calc(var(--blx-code-size) * 1.6 + 2px);line-height:1.6;font-family:var(--blx-code-font);font-size:var(--blx-code-size);font-variant-ligatures:none;white-space:pre}
.blx-diff[data-wrap="on"] .blx-dl{white-space:pre-wrap;overflow-wrap:anywhere}
.blx-diff[data-wrap="on"] .blx-dl-t{flex:1 1 auto;min-width:0}
.blx-dl[data-t="+"]{background:rgba(46,160,67,.16)}
.blx-dl[data-t="-"]{background:rgba(248,81,73,.14)}
.blx-dl-n{flex:0 0 34px;width:34px;text-align:right;padding-right:5px;color:#5d6470;user-select:none}
.blx-dl-s{flex:0 0 13px;width:13px;text-align:center;color:var(--dsw-alias-label-secondary)}
.blx-dl[data-t="+"] .blx-dl-s{color:#7ee787}
.blx-dl[data-t="-"] .blx-dl-s{color:#ff938a}
.blx-dl-t{flex:0 0 auto;padding-right:16px;color:var(--dsw-alias-label-primary,#d7d9de)}
.blx-comment{display:flex;flex-direction:column;gap:6px;padding:8px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1,#26282e)}
.blx-skeleton{display:flex;flex-direction:column;gap:10px;padding:10px}
.blx-skel{height:110px;border-radius:10px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-layer-1));background-size:200% 100%;animation:blx-shimmer 1.4s ease infinite}
@keyframes blx-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.blx-spinner{width:10px;height:10px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--blx-blue);animation:blx-spin .8s linear infinite;display:inline-block;flex:0 0 auto}
@keyframes blx-spin{to{transform:rotate(360deg)}}
`

    function installStyles() {
      const id = 'dsh-side-tex-style'
      if (document.getElementById(id) !== null) return () => {}
      const node = document.createElement('style')
      node.id = id
      node.textContent = CSS
      document.head.appendChild(node)
      return () => {
        node.remove()
      }
    }

    // ── PDF 页面（canvas + 批注层 + 定位闪框） ───────────────────────
    function PdfPageView(props) {
      const {
        doc,
        pageNumber,
        width,
        notes,
        draftRect,
        activeNoteId,
        flash,
        onDraftMove,
        onDraftEnd,
        onOpenNote,
        onPickPoint,
        onAnnotatePoint,
        annotateMode,
        registerRef,
      } = props
      const canvasRef = useRef(null)
      const wrapRef = useRef(null)
      const [size, setSize] = useState(null)
      const drag = useRef(null)
      const [pulse, setPulse] = useState(null)
      // 每次渲染一个令牌：宽度变化时旧任务可能还在 await，写 canvas 前必须确认自己仍然是最新任务，
      // 否则会出现「canvas 按旧宽度绘制、却被新宽度的容器裁掉」。
      const renderToken = useRef(0)

      useEffect(() => {
        if (doc === null || doc === undefined || width <= 0) return undefined
        const token = renderToken.current + 1
        renderToken.current = token
        let disposed = false
        let task = null
        const current = () => !disposed && renderToken.current === token
        ;(async () => {
          try {
            const page = await doc.getPage(pageNumber)
            if (!current()) return
            const base = page.getViewport({ scale: 1 })
            const scale = Math.max(0.12, Math.min(4, width / base.width))
            const viewport = page.getViewport({ scale })
            const canvas = canvasRef.current
            if (canvas === null || !current()) return
            const dpr = window.devicePixelRatio || 1
            const cssWidth = Math.max(1, Math.floor(viewport.width))
            const cssHeight = Math.max(1, Math.floor(viewport.height))
            canvas.width = Math.max(1, Math.floor(cssWidth * dpr))
            canvas.height = Math.max(1, Math.floor(cssHeight * dpr))
            canvas.style.width = `${cssWidth}px`
            canvas.style.height = `${cssHeight}px`
            setSize({ width: cssWidth, height: cssHeight })
            task = page.render({
              canvas,
              viewport,
              transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
            })
            await task.promise
          } catch {
            // 取消（渲染中宽度又变了）或单页失败都不影响其它页
          }
        })()
        return () => {
          // 关键：不仅要让旧任务不再写 canvas，还要取消它在飞行中的绘制，
          // 否则旧 scale 的像素会把新 scale 的画面覆盖掉（表现为 PDF 被裁掉一截）。
          disposed = true
          if (renderToken.current === token) renderToken.current = token + 1
          try {
            task?.cancel()
          } catch {
            // 已结束的渲染任务取消会抛，忽略
          }
        }
      }, [doc, pageNumber, width])

      useEffect(() => {
        if (typeof registerRef === 'function' && wrapRef.current !== null) registerRef(pageNumber, wrapRef.current)
      }, [registerRef, pageNumber])

      const pointOf = (event) => {
        const node = wrapRef.current
        if (node === null) return null
        const rect = node.getBoundingClientRect()
        return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
      }

      const pageNotes = notes.filter((note) => note.page === pageNumber)
      return h(
        'div',
        {
          className: 'blx-page',
          ref: wrapRef,
          title: annotateMode === true ? T('annotateHint') : T('pdfHint'),
          'data-annotate': String(annotateMode === true),
          style: size === null ? { width: Math.max(80, width), height: 240 } : { width: size.width, height: size.height },
          onPointerDown: (event) => {
            if (event.button !== 0) return
            const point = pointOf(event)
            if (point === null) return
            event.preventDefault()
            setPulse({ x: point.x, y: point.y, token: Date.now() })
            drag.current = { start: point, current: point, moved: false }
            try {
              event.currentTarget.setPointerCapture?.(event.pointerId)
            } catch {
              // 某些设备 pointerId 已失效，忽略；不影响拖动判定
            }
          },
          onPointerMove: (event) => {
            if (drag.current === null) return
            const point = pointOf(event)
            if (point === null) return
            drag.current.current = point
            const rect = wrapRef.current?.getBoundingClientRect()
            const dx = Math.abs(point.x - drag.current.start.x) * (rect?.width ?? 1)
            const dy = Math.abs(point.y - drag.current.start.y) * (rect?.height ?? 1)
            if (dx > DRAG_MIN || dy > DRAG_MIN) drag.current.moved = true
            if (drag.current.moved) onDraftMove(pageNumber, rectOf(drag.current.start, point))
          },
          onPointerUp: (event) => {
            const state = drag.current
            drag.current = null
            if (state === null) return
            const point = pointOf(event)
            if (point === null) return
            if (!state.moved) {
              // 批注模式：单击就地开批注框；普通模式：单击定位源码。
              // 不用双击计时，避免延迟/设备差异让功能“消失”。
              if (annotateMode === true) onAnnotatePoint(pageNumber, point.x, point.y)
              else onPickPoint(pageNumber, point.x, point.y)
              return
            }
            onDraftMove(pageNumber, null)
            onDraftEnd(pageNumber, rectOf(state.start, point))
          },
          onPointerCancel: () => {
            drag.current = null
            onDraftMove(pageNumber, null)
          },
          onLostPointerCapture: () => {
            // 指针被系统抢走（切窗口、触控板手势）时收尾，避免半截拖动卡住
            drag.current = null
            onDraftMove(pageNumber, null)
          },
        },
        h('canvas', { ref: canvasRef }),
        pageNotes.map((note) =>
          h('div', {
            key: note.id,
            className: 'blx-note',
            'data-active': String(activeNoteId !== null && activeNoteId === note.id),
            style: {
              left: `${note.rect.x * 100}%`,
              top: `${note.rect.y * 100}%`,
              width: `${note.rect.w * 100}%`,
              height: `${note.rect.h * 100}%`,
            },
            onPointerDown: (event) => event.stopPropagation(),
            onClick: (event) => {
              event.stopPropagation()
              onOpenNote(note)
            },
            title: note.note,
          }),
        ),
        pulse !== null
          ? h('div', {
              key: pulse.token,
              className: 'blx-pulse',
              style: { left: `${pulse.x * 100}%`, top: `${pulse.y * 100}%` },
            })
          : null,
        draftRect !== null && draftRect !== undefined && draftRect.page === pageNumber
          ? h('div', {
              className: 'blx-draft',
              style: {
                left: `${draftRect.rect.x * 100}%`,
                top: `${draftRect.rect.y * 100}%`,
                width: `${draftRect.rect.w * 100}%`,
                height: `${draftRect.rect.h * 100}%`,
              },
            })
          : null,
        flash !== null && flash !== undefined && flash.page === pageNumber
          ? h('div', {
              key: flash.token,
              className: 'blx-flash',
              style: {
                left: `${flash.rect.x * 100}%`,
                top: `${flash.rect.y * 100}%`,
                width: `${flash.rect.w * 100}%`,
                height: `${flash.rect.h * 100}%`,
              },
            })
          : null,
      )
    }

    /** 把两次指针位置转成归一化矩形（含最小尺寸）。 */
    function rectOf(start, end) {
      const x = Math.min(start.x, end.x)
      const y = Math.min(start.y, end.y)
      const w = Math.max(0.02, Math.abs(end.x - start.x))
      const hgt = Math.max(0.012, Math.abs(end.y - start.y))
      return { x: Math.min(0.98, x), y: Math.min(0.98, y), w: Math.min(1 - x, w), h: Math.min(1 - y, hgt) }
    }

    /** 批注锚点 → 显示标签：单行 `@file#L12`，区间 `@file#L12–L18`。 */
    function anchorLabel(file, line, endLine) {
      if (file === null || file === undefined) return null
      const start = Number(line) || 0
      const end = Number(endLine) || start
      return end > start ? `@${file}#L${start}–L${end}` : `@${file}#L${start}`
    }

    /** notes.json 里的批注（含旧版只有 line 的）→ 统一的 {file,line,endLine,quote}。 */
    function sourceOfNote(note) {
      if (note === null || note === undefined || note.file === null || note.file === undefined) return null
      const line = Number(note.line) || 1
      return {
        file: note.file,
        line,
        endLine: Math.max(line, Number(note.endLine) || line),
        quote: typeof note.quote === 'string' ? note.quote : '',
      }
    }

    /** 引用原文按字符数兜底截断（行数由调用方先截）。 */
    function clipQuote(text) {
      if (typeof text !== 'string') return ''
      if (text.length <= QUOTE_MAX_CHARS) return text
      return `${text.slice(0, QUOTE_MAX_CHARS)}…`
    }

    // ── 源码面板 ─────────────────────────────────────────────────────
    function SourcePane(props) {
      const {
        path,
        lines,
        total,
        truncated,
        activeLine,
        changedSet,
        onEdit,
        onLocate,
        onAnnotate,
        onSelectRange,
        sel,
        scrollRef,
        wrap,
        editingLine,
        editText,
        editSaving,
        onEditChange,
        onEditCommit,
        onEditCancel,
        onEditBlur,
        onEditDoubleClick,
        onEditClick,
      } = props
      if (path === null) return h('div', { className: 'blx-empty' }, T('noFile'))
      if (lines.length === 0) return h('div', { className: 'blx-empty' }, T('loadingSource'))
      return h(
        'div',
        { className: 'blx-code-wrap', ref: scrollRef },
        h(
          'div',
          { className: 'blx-code', 'data-wrap': wrap === false ? 'off' : 'on' },
          lines.map((text, index) => {
            const lineNumber = index + 1
            const editing = editingLine === lineNumber
            if (editing) {
              return h(
                'div',
                {
                  key: lineNumber,
                  className: 'blx-cl',
                  'data-line': lineNumber,
                  'data-editing': 'true',
                  'data-active': 'true',
                  onDoubleClick: (event) => {
                    event.stopPropagation()
                    onEditDoubleClick(lineNumber)
                  },
                },
                h('span', { className: 'blx-ln' }, lineNumber),
                h('textarea', {
                  className: 'blx-edit',
                  value: editText,
                  autoFocus: true,
                  spellCheck: false,
                  disabled: editSaving === true,
                  ref: (node) => {
                    if (node === null) return
                    node.style.height = 'auto'
                    node.style.height = `${node.scrollHeight}px`
                    // 刚进编辑：聚焦并把光标放到行尾；只做一次（节点靠 dataset 记状态，
                    // 避免每次按键重渲染都把光标弹回末尾）
                    if (node.dataset.seeded !== '1') {
                      node.dataset.seeded = '1'
                      node.focus()
                      const end = node.value.length
                      try {
                        node.setSelectionRange(end, end)
                      } catch {
                        // 忽略
                      }
                    }
                  },
                  onChange: (event) => {
                    onEditChange(event.target.value)
                    event.target.style.height = 'auto'
                    event.target.style.height = `${event.target.scrollHeight}px`
                  },
                  onKeyDown: (event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      onEditCancel()
                    } else if (event.key === 'Enter') {
                      event.preventDefault()
                      onEditCommit()
                    }
                  },
                  onBlur: () => onEditBlur(),
                  onClick: (event) => {
                    event.stopPropagation()
                    onEditClick(lineNumber)
                  },
                }),
                h('button', {
                  type: 'button',
                  className: 'blx-btn blx-edit-loc',
                  title: T('locate'),
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: (event) => {
                    event.stopPropagation()
                    onLocate(lineNumber)
                  },
                }, '⌖'),
              )
            }
            const inRange = sel !== null && lineNumber >= sel.line && lineNumber <= sel.endLine
            return h(
              'div',
              {
                key: lineNumber,
                className: 'blx-cl',
                'data-line': lineNumber,
                'data-active': String(activeLine === lineNumber),
                'data-sel': String(inRange),
                'data-chg': changedSet.has(lineNumber) ? 'add' : undefined,
                title: T('emptyTray'),
                onClick: (event) => {
                  // Shift+单击：选一段（不进编辑）；普通单击仍是行内编辑
                  if (event.shiftKey) {
                    event.stopPropagation()
                    onSelectRange(lineNumber)
                    return
                  }
                  onEdit(lineNumber)
                },
                onDoubleClick: (event) => {
                  event.stopPropagation()
                  onLocate(lineNumber)
                },
              },
              h('span', { className: 'blx-ln' }, lineNumber),
              h('span', {
                className: 'blx-plus',
                title: inRange ? T('annotateRange') : T('annotateLine'),
                onClick: (event) => {
                  event.stopPropagation()
                  onAnnotate(lineNumber, sel)
                },
              }, '+'),
              h('span', { className: 'blx-code-text' }, text === '' ? ' ' : text),
            )
          }),
          truncated ? h('div', { className: 'blx-note2' }, fmt(T('truncated'), lines.length)) : null,
        ),
      )
    }

    // ── 源码 diff 面板（逐 hunk 决策） ───────────────────────────────
    function DiffPane(props) {
      const {
        files,
        path,
        detail,
        loading,
        busy,
        changedSet,
        onPickFile,
        onDecide,
        onUndo,
        onJumpSource,
        commentFor,
        commentText,
        setCommentText,
        onSubmitComment,
        onCancelComment,
        wrap,
        onToggleWrap,
      } = props

      if (files.length === 0) return h('div', { className: 'blx-empty' }, T('noChanges'))

      const hunks = Array.isArray(detail?.hunks) ? detail.hunks : []
      const allIndexes = hunks.map((hunk, index) => index)

      return h(
        'div',
        { className: 'blx-diff', 'data-wrap': wrap === false ? 'off' : 'on' },
        files.length > 1
          ? h(
          'div',
          { className: 'blx-files' },
          files.map((file) =>
            h(
              'button',
              {
                key: file.path,
                type: 'button',
                className: 'blx-filechip',
                'data-active': String(path === file.path),
                onClick: () => onPickFile(file.path),
                title: file.path,
              },
              h('span', { className: 'blx-filechip-name' }, baseName(file.path)),
              h('span', { className: 'blx-filechip-count' }, `+${file.additions} −${file.deletions}`),
            ),
          ),
        )
          : null,
        h(
          'div',
          { className: 'blx-diff-actions' },
          h('button', { type: 'button', className: 'blx-btn', onClick: onUndo, title: T('undo') }, `↺ ${T('undo')}`),
          h('button', {
            type: 'button',
            className: 'blx-btn',
            'data-variant': 'ok',
            disabled: busy || allIndexes.length === 0,
            onClick: () => onDecide(allIndexes, []),
          }, `✓ ${T('acceptAll')}`),
          h('button', {
            type: 'button',
            className: 'blx-btn',
            'data-variant': 'no',
            disabled: busy || allIndexes.length === 0,
            onClick: () => {
              if (window.confirm(T('rejectAllConfirm'))) onDecide([], allIndexes)
            },
          }, `✕ ${T('rejectAll')}`),
          h('span', { className: 'blx-grow' }),
          h('button', {
            type: 'button',
            className: 'blx-btn',
            'data-active': String(wrap !== false),
            onClick: () => onToggleWrap?.(),
            title: T('wrapHint'),
          }, `↵ ${T('wrap')}`),
        ),
        detail === null || detail === undefined
          ? (loading ? h('div', { className: 'blx-skeleton' }, h('div', { className: 'blx-skel' }), h('div', { className: 'blx-skel' }))
            : h('div', { className: 'blx-empty' }, T('noChanges')))
          : hunks.length === 0
            ? h('div', { className: 'blx-empty' }, T('noChanges'))
            : h(
                'div',
                { className: 'blx-hunks' },
                hunks.map((hunk, index) =>
                  h(
                    'div',
                    { key: index, className: 'blx-hunk' },
                    h(
                      'div',
                      { className: 'blx-hunk-head' },
                      h('span', { className: 'blx-badge blx-hunk-range' }, `#${index + 1}`),
                      h('span', { className: 'blx-hunk-range' }, `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`),
                      h('span', { className: 'blx-grow' }),
                      h('button', { type: 'button', className: 'blx-btn', onClick: () => onJumpSource(hunk.newStart), title: T('jumpSource') }, '⌖'),
                      h('button', {
                        type: 'button',
                        className: 'blx-btn',
                        'data-variant': 'ok',
                        disabled: busy,
                        onClick: () => onDecide([index], []),
                      }, `✓ ${T('accept')}`),
                      h('button', {
                        type: 'button',
                        className: 'blx-btn',
                        'data-variant': 'no',
                        disabled: busy,
                        onClick: () => {
                          if (window.confirm(T('rejectConfirm'))) onDecide([], [index])
                        },
                      }, `✕ ${T('reject')}`),
                      h('button', {
                        type: 'button',
                        className: 'blx-btn',
                        onClick: () => (commentFor === index ? onCancelComment() : props.onComment(index)),
                        'data-active': String(commentFor === index),
                      }, `💬 ${T('comment')}`),
                    ),
                    h(
                      'div',
                      { className: 'blx-hunk-body' },
                      hunk.body.map((line, lineIndex) =>
                        h(
                          'div',
                          { key: lineIndex, className: 'blx-dl', 'data-t': line.type },
                          h('span', { className: 'blx-dl-n' }, line.type === '-' ? (line.oldLine ?? '') : (line.newLine ?? '')),
                          h('span', { className: 'blx-dl-s' }, line.type === '=' ? ' ' : line.type),
                          h('span', { className: 'blx-dl-t' }, line.text === '' ? ' ' : line.text),
                        ),
                      ),
                    ),
                    commentFor === index
                      ? h(
                          'div',
                          { className: 'blx-comment' },
                          h('textarea', {
                            value: commentText,
                            onChange: (event) => setCommentText(event.target.value),
                            placeholder: T('notePlaceholder'),
                            autoFocus: true,
                          }),
                          h('div', { className: 'blx-row' },
                            h('button', { type: 'button', className: 'blx-btn', 'data-variant': 'primary', onClick: onSubmitComment }, T('comment')),
                            h('button', { type: 'button', className: 'blx-btn', onClick: onCancelComment }, T('cancel')),
                            h('span', { className: 'blx-dim' }, T('commentHint')),
                          ),
                        )
                      : null,
                  ),
                ),
              ),
      )
    }

    // ── 主组件 ───────────────────────────────────────────────────────
    function LatexTab(props) {
      const ctx = props.ctx
      const sessionId = props.sessionId

      const [status, setStatus] = useState(null)
      const [failure, setFailure] = useState(null)
      const [notice, setNotice] = useState(null)
      const [notes, setNotes] = useState([])
      const [draft, setDraft] = useState(null)
      const [pdf, setPdf] = useState(null)
      const [pdfError, setPdfError] = useState(null)
      const [pdfRetry, setPdfRetry] = useState(0)
      const [busy, setBusy] = useState(false)
      const [zoom, setZoom] = useState(1)
      const [layout, setLayout] = useState(() => readPref('layout', 'split'))
      const [leftTab, setLeftTab] = useState('source')
      const [activeFile, setActiveFile] = useState(null)
      const [activeLine, setActiveLine] = useState(null)
      const [src, setSrc] = useState({ path: null, lines: [], total: 0, truncated: false, loading: false, mtimeMs: null })
      const [editLine, setEditLine] = useState(null)
      const [editText, setEditText] = useState('')
      const [editOriginal, setEditOriginal] = useState('')
      const [editSaving, setEditSaving] = useState(false)
      const [diff, setDiff] = useState({ path: null, value: null, loading: false })
      const [commentFor, setCommentFor] = useState(null)
      const [commentText, setCommentText] = useState('')
      const [dragRect, setDragRect] = useState(null)
      const [annotateMode, setAnnotateMode] = useState(false)
      const [srcSel, setSrcSel] = useState(null)
      const [resolvingRange, setResolvingRange] = useState(false)
      const [flash, setFlash] = useState(null)
      const [currentPage, setCurrentPage] = useState(1)
      const [splitRatio, setSplitRatio] = useState(() => {
        const value = Number(readPref('split', 0.46))
        return Number.isFinite(value) ? Math.min(0.8, Math.max(0.2, value)) : 0.46
      })
      const [pdfWidth, setPdfWidth] = useState(380)
      const [dragging, setDragging] = useState(false)
      const [codeFont, setCodeFont] = useState(() => {
        const value = String(readPref('codeFont', DEFAULT_CODE_FONT))
        return Object.hasOwn(CODE_FONTS, value) ? value : DEFAULT_CODE_FONT
      })
      const [codeSize, setCodeSize] = useState(() => {
        const value = Number(readPref('codeSize', DEFAULT_CODE_SIZE))
        if (!Number.isFinite(value)) return DEFAULT_CODE_SIZE
        return Math.min(CODE_SIZE_MAX, Math.max(CODE_SIZE_MIN, Math.round(value)))
      })
      const [wrapSource, setWrapSource] = useState(() => readPref('codeWrap', true) !== false)
      const [showCodeCfg, setShowCodeCfg] = useState(false)

      const pdfScrollRef = useRef(null)
      const srcScrollRef = useRef(null)
      const bodyRef = useRef(null)
      const pageRefs = useRef(new Map())
      const lastRev = useRef(null)
      const docRef = useRef(null)
      const pendingLine = useRef(null)
      const editTimer = useRef(null)
      const editOpenedAt = useRef(0)
      const ratioRef = useRef(splitRatio)
      /** 选区解析令牌：连续拖框时只接受最后一次结果。 */
      const rangeToken = useRef(0)

      useEffect(() => {
        ratioRef.current = splitRatio
      }, [splitRatio])

      const scopeOf = useCallback(() => {
        const sessions = ctx.get('sessions')
        return sessions?.scope?.(sessionId) ?? null
      }, [ctx, sessionId])

      /** 把文本追加进会话输入框，失败退回剪贴板。 */
      const insertDraft = useCallback(async (text) => {
        if (text === '') return false
        try {
          const conversation = ctx.get('conversation')
          const input = conversation?.input?.for?.(scopeOf())
          if (input?.setDraft !== undefined) {
            const current = input.state?.getSnapshot?.().draft ?? ''
            input.setDraft(`${current}${current.trim() === '' ? '' : '\n'}${text}`)
            return true
          }
        } catch {
          // 退回剪贴板
        }
        try {
          await navigator.clipboard?.writeText(text)
        } catch {
          // 忽略
        }
        return false
      }, [ctx, scopeOf])

      const refresh = useCallback(async (initial) => {
        if (sessionId === undefined) return
        try {
          const value = await call(initial === true ? 'project' : 'status', { sessionId })
          setStatus(value)
          setFailure(null)
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        }
      }, [sessionId])

      useEffect(() => {
        void refresh(true)
        void (async () => {
          try {
            const value = await call('notes.list', { sessionId })
            setNotes(Array.isArray(value?.notes) ? value.notes : [])
          } catch {
            // 忽略
          }
        })()
        const timer = setInterval(() => {
          void refresh(false)
        }, document.visibilityState === 'visible' ? 1200 : 4000)
        return () => clearInterval(timer)
      }, [refresh, sessionId])

      // 默认显示主文件
      useEffect(() => {
        if (activeFile === null && typeof status?.mainFile === 'string' && status.mainFile !== '') setActiveFile(status.mainFile)
      }, [status?.mainFile, activeFile])

      // 当前 PDF（文档句柄放 ref，销毁是显式副作用，不在 setState updater 里做）
      useEffect(() => {
        const rev = status?.rev
        const revKey = rev === null || rev === undefined ? null : `${rev}:${pdfRetry}`
        if (revKey === null || lastRev.current === revKey) return undefined
        lastRev.current = revKey
        let cancelled = false
        setPdfError(null)
        setFlash(null)
        ;(async () => {
          if (status.pdfjs === false) {
            setPdf({ fallback: true, doc: null, numPages: 0 })
            return
          }
          try {
            const pdfjs = await loadPdfjs()
            const response = await fetch(pdfUrl(sessionId, rev, 'current'))
            if (!response.ok) throw new Error(`PDF HTTP ${response.status}`)
            const data = new Uint8Array(await response.arrayBuffer())
            const doc = await openPdfDocument(pdfjs, data)
            if (cancelled) {
              destroyDoc(doc)
              return
            }
            pageRefs.current = new Map()
            const previousDoc = docRef.current
            docRef.current = doc
            setPdf({ doc, numPages: doc.numPages, fallback: false })
            destroyDoc(previousDoc)
          } catch (error) {
            if (!cancelled) {
              setPdf({ fallback: true, doc: null, numPages: 0 })
              setPdfError(error instanceof Error ? error.message : String(error))
            }
          }
        })()
        return () => {
          cancelled = true
        }
      }, [sessionId, status?.rev, status?.pdfjs, pdfRetry])

      // 卸载时释放 pdf.js 文档
      useEffect(() => () => {
        destroyDoc(docRef.current)
        docRef.current = null
      }, [])

      // PDF 面板宽度
      useEffect(() => {
        if (layout === 'source') return undefined
        const node = pdfScrollRef.current
        if (node === null) return undefined
        const measure = () => {
          // 用 rect 宽度（包含滚动条占位），避免滚动条出现/消失引起宽度来回抖动
          const width = node.getBoundingClientRect().width
          setPdfWidth(Math.max(120, Math.min(2400, Math.floor(width) - 18)))
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        return () => observer.disconnect()
      }, [layout, pdf])

      // 通知自动消失
      useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => setNotice(null), 4200)
        return () => clearTimeout(timer)
      }, [notice])

      // 活动文件的 mtime（用于源码/差异自动刷新）
      const activeMtime = useMemo(() => {
        const files = status?.changes?.files ?? []
        const hit = files.find((file) => file.path === activeFile)
        return hit?.mtimeMs ?? 0
      }, [status?.changes?.files, activeFile])

      const loadSource = useCallback(async (path) => {
        if (sessionId === undefined || path === null) return
        setSrc((previous) => ({ ...previous, path, loading: true }))
        try {
          const value = await call('source', { sessionId, path, maxLines: MAX_LINES })
          setSrc({
            path: value?.path ?? path,
            lines: Array.isArray(value?.lines) ? value.lines : [],
            total: value?.total ?? (value?.lines ?? []).length,
            truncated: value?.truncated === true,
            loading: false,
            mtimeMs: Number.isFinite(value?.mtimeMs) ? value.mtimeMs : null,
          })
        } catch (error) {
          setSrc({ path, lines: [], total: 0, truncated: false, loading: false, mtimeMs: null })
          setFailure(error instanceof Error ? error.message : String(error))
        }
      }, [sessionId])

      const loadDiff = useCallback(async (path) => {
        if (sessionId === undefined || path === null) return
        setDiff((previous) => ({ ...previous, path, loading: true }))
        try {
          const value = await call('diff', { sessionId, path })
          setDiff({ path, value: value ?? null, loading: false })
        } catch {
          setDiff({ path, value: null, loading: false })
        }
      }, [sessionId])

      useEffect(() => {
        if (activeFile === null) return
        void loadSource(activeFile)
      }, [activeFile, status?.rev, activeMtime, loadSource])

      useEffect(() => {
        if (activeFile === null) return
        void loadDiff(activeFile)
      }, [activeFile, status?.rev, activeMtime, loadDiff])

      /** 把某个源码行滚到可视区：换行后行高不固定，用 DOM 查找而不是固定行高。 */
      const scrollSourceToLine = useCallback((line, behavior = 'smooth') => {
        const node = srcScrollRef.current
        if (node === null) return
        const target = node.querySelector(`.blx-cl[data-line="${line}"]`)
        if (target === null) return
        const box = node.getBoundingClientRect()
        const rect = target.getBoundingClientRect()
        const top = node.scrollTop + (rect.top - box.top) - node.clientHeight * 0.3
        node.scrollTo({ top: Math.max(0, top), behavior })
      }, [])

      // 源码加载完成后滚动到待定位行
      useEffect(() => {
        const line = pendingLine.current
        if (line === null || src.path !== activeFile || src.lines.length < line) return
        pendingLine.current = null
        scrollSourceToLine(line)
      }, [src, activeFile, scrollSourceToLine])

      const changedSet = useMemo(() => {
        const set = new Set()
        const hunks = diff.value?.hunks ?? []
        for (const hunk of hunks) {
          for (const line of hunk.body ?? []) {
            if (line.type === '+' && Number.isFinite(line.newLine)) set.add(line.newLine)
          }
        }
        return set
      }, [diff.value])

      const scrollPdfTo = useCallback((pageNumber, normalizedY) => {
        const node = pdfScrollRef.current
        const pageEl = pageRefs.current.get(pageNumber)
        if (node === null || pageEl === undefined) return
        const box = node.getBoundingClientRect()
        const rect = pageEl.getBoundingClientRect()
        const target = node.scrollTop + (rect.top - box.top) + (normalizedY ?? 0) * rect.height - node.clientHeight * 0.28
        node.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
      }, [])

      /** 页面尺寸（PDF 点），用于归一化坐标与 synctex 坐标互换。 */
      const pageSizeOf = useCallback(async (pageNumber) => {
        try {
          const proxy = await pdf?.doc?.getPage(pageNumber)
          if (proxy !== undefined && proxy !== null) {
            const viewport = proxy.getViewport({ scale: 1 })
            return { width: viewport.width, height: viewport.height }
          }
        } catch {
          // 用默认页面尺寸
        }
        return { width: 612, height: 792 }
      }, [pdf])

      /** 取源码一段（line..endLine）的原文，最多 QUOTE_MAX_LINES 行。 */
      const readQuote = useCallback(async (file, line, endLine) => {
        const start = Math.max(1, Number(line) || 1)
        const stop = Math.min(Math.max(start, Number(endLine) || start), start + QUOTE_MAX_LINES - 1)
        const join = (lines) => clipQuote(lines.map((text) => String(text ?? '')).join('\n'))
        if (file === src.path && src.lines.length >= start) {
          const local = src.lines.slice(start - 1, stop)
          if (local.length > 0) return join(local)
        }
        try {
          const value = await call('source', { sessionId, path: file, maxLines: stop })
          const lines = Array.isArray(value?.lines) ? value.lines.slice(start - 1, stop) : []
          return join(lines)
        } catch {
          return ''
        }
      }, [sessionId, src])

      /** 由 PDF 点解析源码位置与原文行。 */
      const resolveSource = useCallback(async (page, x, y) => {
        try {
          const found = await call('sync.edit', { sessionId, page, x, y })
          if (found?.ok !== true) return null
          let quote = ''
          if (found.file === src.path && Number.isFinite(found.line) && src.lines[found.line - 1] !== undefined) {
            quote = src.lines[found.line - 1]
          } else {
            try {
              const value = await call('source', { sessionId, path: found.file, maxLines: Math.max(1, found.line) })
              quote = value?.lines?.[found.line - 1] ?? ''
            } catch {
              quote = ''
            }
          }
          return { file: found.file, line: found.line, quote }
        } catch {
          return null
        }
      }, [sessionId, src])

      /** 源码行 → PDF：滚动并闪框高亮。 */
      const revealInPdf = useCallback(async (file, line) => {
        try {
          const view = await call('sync.view', { sessionId, file, line })
          if (view?.ok !== true) {
            setNotice(T('syncOff'))
            return false
          }
          const size = await pageSizeOf(view.page)
          const height = view.height || 10
          const rect = {
            x: Math.max(0, Math.min(0.96, view.x / size.width)),
            y: Math.max(0, Math.min(0.96, (view.y - height) / size.height)),
            w: Math.max(0.03, Math.min(0.96, Math.max(view.width || 40, 24) / size.width)),
            h: Math.max(0.012, Math.min(0.4, height / size.height)),
          }
          setCurrentPage(view.page)
          setFlash({ page: view.page, rect, token: Date.now() })
          if (layout === 'source') setLayout('split')
          setTimeout(() => scrollPdfTo(view.page, rect.y), 90)
          return true
        } catch (error) {
          setNotice(error instanceof Error ? error.message : T('syncOff'))
          return false
        }
      }, [sessionId, pageSizeOf, layout, scrollPdfTo])

      /** 跳转到某个源码位置（可跨文件）。 */
      const revealInSource = useCallback((file, line) => {
        setLeftTab('source')
        if (file !== activeFile) setActiveFile(file)
        setActiveLine(line)
        pendingLine.current = line
        if (layout === 'pdf') setLayout('split')
        if (file === activeFile) {
          scrollSourceToLine(line)
          setTimeout(() => scrollSourceToLine(line), 90)
        }
      }, [activeFile, layout, scrollSourceToLine])

      /** PDF 单击：定位源码。 */
      const pickPoint = useCallback(async (page, nx, ny) => {
        const size = await pageSizeOf(page)
        const found = await resolveSource(page, nx * size.width, ny * size.height)
        if (found === null) {
          setNotice(T('syncOff'))
          return
        }
        setCurrentPage(page)
        revealInSource(found.file, found.line)
      }, [pageSizeOf, resolveSource, revealInSource])

      /** PDF 拖框：矩形 → 源码行区间（不可用/失败时回退单点反查），再开批注草稿。 */
      const openDraftFromRect = useCallback(async (page, rect) => {
        const token = rangeToken.current + 1
        rangeToken.current = token
        setResolvingRange(true)
        const size = await pageSizeOf(page)
        let found = null
        let groups = []
        try {
          const value = await call('sync.range', {
            sessionId,
            page,
            x: rect.x * size.width,
            y: rect.y * size.height,
            w: Math.max(1, rect.w * size.width),
            h: Math.max(1, rect.h * size.height),
          })
          if (value?.ok === true) {
            found = {
              file: value.file,
              line: Math.max(1, Number(value.line) || 1),
              endLine: Math.max(1, Number(value.endLine) || Number(value.line) || 1),
            }
            groups = Array.isArray(value.groups) ? value.groups : []
          }
        } catch {
          // Host 还是旧版（没有 sync.range）：回退单点反查
        }
        if (rangeToken.current !== token) return
        if (found === null) {
          const point = await resolveSource(
            page,
            (rect.x + Math.min(rect.w / 2, 0.2)) * size.width,
            (rect.y + Math.min(rect.h / 2, 0.03)) * size.height,
          )
          if (rangeToken.current !== token) return
          if (point !== null) found = { file: point.file, line: point.line, endLine: point.line }
        }
        const quote = found === null ? '' : await readQuote(found.file, found.line, found.endLine)
        if (rangeToken.current !== token) return
        setResolvingRange(false)
        setDraft({ id: null, page, rect, text: '', source: found === null ? null : { ...found, quote }, groups })
        if (found !== null) {
          setSrcSel({ file: found.file, line: found.line, endLine: found.endLine })
          revealInSource(found.file, found.line)
        }
      }, [sessionId, pageSizeOf, readQuote, resolveSource, revealInSource])

      /** 批注模式单击：以点为中心给一个默认框，直接开批注。 */
      const annotatePoint = useCallback((page, nx, ny) => {
        const rect = {
          x: Math.max(0, Math.min(0.9, nx - 0.25)),
          y: Math.max(0, Math.min(0.95, ny - 0.01)),
          w: 0.5,
          h: 0.03,
        }
        void openDraftFromRect(page, rect)
      }, [openDraftFromRect])

      /** 批注一段源码：正查首/末行，同页取并集矩形，再开编辑框。 */
      const annotateLine = useCallback(async (fileArg, lineArg, endArg) => {
        const file = fileArg ?? src.path
        const start = lineArg ?? activeLine
        if (file === null || file === undefined || start === null || start === undefined) {
          setNotice(T('noAnchor'))
          return
        }
        const end = Math.max(Number(start) || 1, Number(endArg) || Number(start) || 1)
        let page = currentPage
        let rect = null
        let crossPage = false
        try {
          const first = await call('sync.view', { sessionId, file, line: start })
          if (first?.ok === true) {
            const size = await pageSizeOf(first.page)
            page = first.page
            let x0 = first.x
            let x1 = first.x + Math.max(first.width || 40, 24)
            let top = first.y - (first.height || 10)
            let bottom = first.y
            if (end > start) {
              const last = await call('sync.view', { sessionId, file, line: end })
              if (last?.ok === true) {
                if (last.page !== page) {
                  crossPage = true
                } else {
                  x0 = Math.min(x0, last.x)
                  x1 = Math.max(x1, last.x + Math.max(last.width || 40, 24))
                  top = Math.min(top, last.y - (last.height || 10))
                  bottom = Math.max(bottom, last.y)
                }
              }
            }
            top = Math.max(0, top - 2)
            bottom = bottom + 2
            rect = {
              x: Math.max(0, Math.min(0.96, x0 / size.width)),
              y: Math.max(0, Math.min(0.96, top / size.height)),
              w: Math.max(0.03, Math.min(0.96, (x1 - x0) / size.width)),
              h: Math.max(0.012, Math.min(0.9, (bottom - top) / size.height)),
            }
            setCurrentPage(page)
            setFlash({ page, rect, token: Date.now() })
            setTimeout(() => scrollPdfTo(page, rect.y), 90)
          }
        } catch {
          // 无锚点：仍允许写字，只是不带页面框
        }
        if (crossPage) setNotice(T('crossPage'))
        const quote = await readQuote(file, start, end)
        const draftRectValue = rect ?? { x: 0.1, y: Math.min(0.9, 0.1 + start * 0.001), w: 0.8, h: 0.02 }
        setDraft({
          id: null,
          page,
          rect: draftRectValue,
          text: '',
          source: { file, line: start, endLine: end, quote },
          groups: [],
          anchored: rect !== null,
        })
        setSrcSel({ file, line: start, endLine: end })
      }, [activeLine, src.path, sessionId, pageSizeOf, scrollPdfTo, currentPage, readQuote])

      // ── 行内编辑：单击进编辑、双击定位 ─────────────────────────
      /** 单击后延迟进编辑，给双击留窗口。 */
      const scheduleEdit = useCallback((line) => {
        if (editTimer.current !== null) clearTimeout(editTimer.current)
        editTimer.current = setTimeout(() => {
          editTimer.current = null
          const text = src.lines[line - 1] ?? ''
          editOpenedAt.current = Date.now()
          setEditLine(line)
          setEditText(text)
          setEditOriginal(text)
          setActiveLine(line)
        }, 200)
      }, [src.lines])

      /** 慢速双击的第二下落在编辑框里：距进入编辑很近时按定位处理，之后仍是正常点选。 */
      const editClick = useCallback((line) => {
        if (Date.now() - editOpenedAt.current > 900) return
        setEditLine(null)
        setActiveLine(line)
        if (src.path !== null) void revealInPdf(src.path, line)
      }, [src.path, revealInPdf])

      /** 刚进编辑就双击（慢速双击被 200ms 定时器抢先）：按定位处理；之后双击仍是选词。 */
      const editDoubleClick = useCallback((line) => {
        if (Date.now() - editOpenedAt.current > 900) return
        setEditLine(null)
        setActiveLine(line)
        if (src.path !== null) void revealInPdf(src.path, line)
      }, [src.path, revealInPdf])

      /** 双击：取消待编辑，跳 PDF。 */
      const locateLine = useCallback((line) => {
        if (editTimer.current !== null) {
          clearTimeout(editTimer.current)
          editTimer.current = null
        }
        setEditLine(null)
        setActiveLine(line)
        if (src.path !== null) void revealInPdf(src.path, line)
      }, [src.path, revealInPdf])

      const cancelEdit = useCallback(() => {
        setEditLine(null)
        setEditText('')
        setEditOriginal('')
      }, [])

      /** 保存当前行：写文件（mtime CAS）→ 刷新源码/差异；没开自动编译时由 Host 补编译。 */
      const commitEdit = useCallback(async () => {
        if (editLine === null || editSaving) return
        if (editText === editOriginal) {
          cancelEdit()
          return
        }
        setEditSaving(true)
        const path = src.path
        const line = editLine
        const text = editText
        try {
          const value = await call('write.source', {
            sessionId,
            path,
            line,
            text,
            ...(Number.isFinite(src.mtimeMs) ? { expectedMtimeMs: src.mtimeMs } : {}),
          })
          cancelEdit()
          setSrc({
            path: value?.path ?? path,
            lines: Array.isArray(value?.lines) ? value.lines : src.lines,
            total: Array.isArray(value?.lines) ? value.lines.length : src.total,
            truncated: false,
            loading: false,
            mtimeMs: Number.isFinite(value?.mtimeMs) ? value.mtimeMs : src.mtimeMs,
          })
          await refresh(false)
          if (path !== null) await loadDiff(path)
          setNotice(T('saved'))
        } catch (error) {
          cancelEdit()
          if (error?.code === 'conflict') {
            setNotice(T('conflict'))
            if (path !== null) await loadSource(path)
          } else {
            setFailure(error instanceof Error ? error.message : String(error))
          }
        } finally {
          setEditSaving(false)
        }
      }, [editLine, editText, editOriginal, editSaving, src, sessionId, refresh, loadDiff, loadSource, cancelEdit])

      /** 失焦：改过就保存，没改就退出（避免误点产生空写）。 */
      const blurEdit = useCallback(() => {
        if (editLine === null || editSaving) return
        if (editText === editOriginal) cancelEdit()
        else void commitEdit()
      }, [editLine, editSaving, editText, editOriginal, cancelEdit, commitEdit])

      useEffect(() => () => {
        if (editTimer.current !== null) clearTimeout(editTimer.current)
      }, [])

      const saveNotes = useCallback(async (next) => {
        setNotes(next)
        try {
          await call('notes.save', { sessionId, notes: next })
        } catch {
          // 忽略持久化失败
        }
      }, [sessionId])

      const commitDraft = useCallback(async () => {
        if (draft === null) return
        const text = draft.text.trim()
        if (text === '') {
          setNotice(T('emptyNote'))
          return
        }
        const note = {
          id: draft.id ?? `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          page: draft.page,
          rect: draft.rect,
          file: draft.source?.file ?? null,
          line: draft.source?.line ?? null,
          endLine: draft.source?.endLine ?? draft.source?.line ?? null,
          quote: draft.source?.quote ?? '',
          note: text,
          createdAt: Date.now(),
        }
        const next = draft.id === null ? [...notes, note] : notes.map((entry) => (entry.id === draft.id ? note : entry))
        await saveNotes(next)
        setDraft(null)
      }, [draft, notes, saveNotes])

      const deleteDraft = useCallback(async () => {
        if (draft === null) return
        if (draft.id !== null) await saveNotes(notes.filter((entry) => entry.id !== draft.id))
        setDraft(null)
      }, [draft, notes, saveNotes])

      /** 选区覆盖多个文件时换锚点：重新取原文并高亮对应的源码行。 */
      const pickGroup = useCallback(async (group) => {
        if (draft === null || group === null || group === undefined) return
        const start = Math.max(1, Number(group.line) || 1)
        const end = Math.max(start, Number(group.endLine) || start)
        const quote = await readQuote(group.file, start, end)
        setDraft((previous) => (previous === null
          ? previous
          : { ...previous, source: { file: group.file, line: start, endLine: end, quote } }))
        setSrcSel({ file: group.file, line: start, endLine: end })
        revealInSource(group.file, start)
      }, [draft, readQuote, revealInSource])

      const sendNotes = useCallback(async () => {
        if (notes.length === 0) return
        const lines = ['请按以下批注修改论文（每条含源码位置与原文）：', '']
        notes.forEach((note, index) => {
          const start = Number(note.line) || 1
          const end = Math.max(start, Number(note.endLine) || start)
          const count = end - start + 1
          const where = note.file === null || note.file === undefined
            ? `第 ${note.page} 页（未定位到源码）`
            : `@${note.file}#L${start}${end > start ? `–L${end}（${count} 行）` : ''}`
          lines.push(`${index + 1}) ${where}`)
          if (note.quote) {
            for (const quoted of String(note.quote).split(/\r?\n/)) lines.push(`> ${quoted}`)
          }
          lines.push(`批注：${note.note}`)
          lines.push('')
        })
        const ok = await insertDraft(lines.join('\n'))
        if (ok) {
          await saveNotes([])
          setNotice(T('sent'))
        } else {
          setNotice(T('copied'))
        }
      }, [notes, insertDraft, saveNotes])

      const runCompile = useCallback(async () => {
        setBusy(true)
        try {
          await call('compile', { sessionId })
          await refresh(false)
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }, [sessionId, refresh])

      const toggleAuto = useCallback(async () => {
        const next = status?.settings?.autoCompile !== true
        try {
          await call('settings', { sessionId, settings: { autoCompile: next } })
          await refresh(false)
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        }
      }, [sessionId, status?.settings?.autoCompile, refresh])

      const changeEngine = useCallback(async (engine) => {
        try {
          await call('settings', { sessionId, settings: { engine } })
          await refresh(false)
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        }
      }, [sessionId, refresh])

      const changeMainFile = useCallback(async (mainFile) => {
        try {
          await call('mainFile', { sessionId, mainFile })
          setActiveFile(mainFile)
          await refresh(false)
          await runCompile()
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        }
      }, [sessionId, refresh, runCompile])

      const decide = useCallback(async (accept, reject) => {
        const value = diff.value
        if (value === null || value === undefined) return
        setBusy(true)
        try {
          await call('decide', {
            sessionId,
            path: value.path,
            accept: Array.isArray(accept) ? accept : [],
            reject: Array.isArray(reject) ? reject : [],
            ...(Number.isFinite(value.currentMtimeMs) ? { expectedMtimeMs: value.currentMtimeMs } : {}),
          })
          await refresh(false)
          await loadDiff(value.path)
          if (activeFile !== null) await loadSource(activeFile)
          setCommentFor(null)
          setCommentText('')
        } catch (error) {
          if (error?.code === 'conflict') {
            setNotice(T('conflict'))
            await loadDiff(value.path)
            await refresh(false)
            if (activeFile !== null) await loadSource(activeFile)
          } else {
            setFailure(error instanceof Error ? error.message : String(error))
          }
        } finally {
          setBusy(false)
        }
      }, [sessionId, diff.value, refresh, loadDiff, loadSource, activeFile])

      const undoDecision = useCallback(async () => {
        setBusy(true)
        try {
          await call('undo', { sessionId })
          await refresh(false)
          if (activeFile !== null) {
            await loadDiff(activeFile)
            await loadSource(activeFile)
          }
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }, [sessionId, refresh, activeFile, loadDiff, loadSource])

      const submitComment = useCallback(async () => {
        const text = commentText.trim()
        const detailValue = diff.value
        if (text === '' || detailValue === null || detailValue === undefined) return
        const hunk = Array.isArray(detailValue.hunks) ? detailValue.hunks[commentFor] : undefined
        if (hunk === undefined) return
        const quote = (hunk.body ?? [])
          .filter((line) => line.type !== '-')
          .slice(0, 6)
          .map((line) => `> ${line.text}`)
          .join('\n')
        await insertDraft(`请按这条评论修订 @${detailValue.path}#L${hunk.newStart} 附近的改动：\n${quote}\n评论：${text}`)
        setCommentFor(null)
        setCommentText('')
        setNotice(T('sent'))
      }, [commentText, diff.value, commentFor, insertDraft])

      const onDividerDown = useCallback((event) => {
        event.preventDefault()
        const body = bodyRef.current
        if (body === null) return
        const rect = body.getBoundingClientRect()
        setDragging(true)
        const move = (moveEvent) => {
          if (rect.width <= 0) return
          const ratio = Math.min(0.8, Math.max(0.2, (moveEvent.clientX - rect.left) / rect.width))
          setSplitRatio(ratio)
        }
        const up = () => {
          setDragging(false)
          writePref('split', ratioRef.current)
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }, [])

      const chooseLayout = useCallback((next) => {
        setLayout(next)
        writePref('layout', next)
      }, [])

      const chooseFont = useCallback((value) => {
        setCodeFont(value)
        writePref('codeFont', value)
      }, [])

      /** 字号步进（10–20），并持久化。 */
      const stepSize = useCallback((delta) => {
        setCodeSize((previous) => {
          const next = Math.min(CODE_SIZE_MAX, Math.max(CODE_SIZE_MIN, previous + delta))
          writePref('codeSize', next)
          return next
        })
      }, [])

      const toggleWrap = useCallback(() => {
        setWrapSource((previous) => {
          const next = !previous
          writePref('codeWrap', next)
          return next
        })
      }, [])

      const noToolchain = status !== null && status.toolchain === null
      const noMain = status !== null && status.mainFile === null
      const changedFiles = status?.changes?.files ?? []
      const hunkCount = Array.isArray(diff.value?.hunks) ? diff.value.hunks.length : 0
      const candidates = useMemo(() => {
        const list = Array.isArray(status?.mainFileCandidates) ? status.mainFileCandidates.slice(0, 40) : []
        if (status?.mainFile !== null && status?.mainFile !== undefined && !list.includes(status.mainFile)) list.unshift(status.mainFile)
        return list
      }, [status?.mainFile, status?.mainFileCandidates])

      if (sessionId === undefined) return h('div', { className: 'blx-empty' }, 'No session')

      const leftStyle = layout === 'source'
        ? { flex: '1 1 auto' }
        : layout === 'pdf'
          ? { display: 'none' }
          : { flex: `0 0 ${(splitRatio * 100).toFixed(3)}%`, width: `${(splitRatio * 100).toFixed(3)}%` }
      const rightStyle = layout === 'pdf'
        ? { flex: '1 1 auto' }
        : layout === 'source'
          ? { display: 'none' }
          : { flex: '1 1 0' }

      const currentPath = src.path ?? activeFile ?? status?.mainFile ?? null
      /** 当前文件里的源码选区（跨文件时不显示，避免高亮错文件）。 */
      const selHere = srcSel !== null && srcSel.file === currentPath ? srcSel : null

      const leftHead = h(
        'div',
        { className: 'blx-pane-head' },
        h(Seg, {
          value: leftTab,
          onChange: setLeftTab,
          options: [
            { value: 'source', label: T('srcTab') },
            { value: 'diff', label: changedFiles.length > 0 ? `${T('diffTab')} ${hunkCount || changedFiles.length}` : T('diffTab') },
          ],
        }),
        h('span', { className: 'blx-path blx-grow', title: currentPath ?? '' }, currentPath === null ? T('noFile') : currentPath),
        leftTab === 'diff' && diff.value !== null && diff.value !== undefined
          ? h('span', { className: 'blx-badge blx-mini', title: `${hunkCount} 处改动` }, `#${hunkCount} +${diff.value.additions} −${diff.value.deletions}`)
          : null,
        leftTab === 'source'
          ? h('button', {
              type: 'button',
              className: 'blx-btn',
              'data-variant': selHere === null ? undefined : 'soft',
              disabled: selHere === null && activeLine === null,
              onClick: () => {
                if (selHere !== null) void annotateLine(currentPath, selHere.line, selHere.endLine)
                else void annotateLine(activeFile, activeLine)
              },
              title: selHere === null ? T('annotateLine') : T('annotateRange'),
            }, selHere === null
              ? `＋ ${T('annotateLine')}`
              : `＋ ${T('annotateRange')} ${selHere.endLine > selHere.line ? `L${selHere.line}–${selHere.endLine}` : `L${selHere.line}`}`)
          : null,
        leftTab === 'source' && selHere !== null
          ? h('button', {
              type: 'button',
              className: 'blx-btn',
              onClick: () => setSrcSel(null),
              title: T('clearSel'),
            }, '✕')
          : null,
      )

      const leftBody = leftTab === 'source'
        ? h(SourcePane, {
            path: currentPath,
            lines: src.path === currentPath ? src.lines : [],
            total: src.total,
            truncated: src.truncated,
            activeLine,
            changedSet,
            sel: selHere === null ? null : { line: selHere.line, endLine: selHere.endLine },
            scrollRef: srcScrollRef,
            wrap: wrapSource,
            editingLine: editLine,
            editText,
            editSaving,
            onEditChange: setEditText,
            onEditCommit: () => { void commitEdit() },
            onEditCancel: cancelEdit,
            onEditBlur: blurEdit,
            onEditDoubleClick: editDoubleClick,
            onEditClick: editClick,
            onEdit: scheduleEdit,
            onLocate: locateLine,
            onSelectRange: (line) => {
              const anchor = selHere !== null ? selHere.line : (activeLine ?? line)
              const start = Math.min(anchor, line)
              const end = Math.max(anchor, line)
              setSrcSel({ file: currentPath, line: start, endLine: end })
              setActiveLine(start)
            },
            onAnnotate: (line, range) => {
              const inside = range !== null && range !== undefined && line >= range.line && line <= range.endLine
              const start = inside ? range.line : line
              const end = inside ? range.endLine : line
              setActiveLine(start)
              void annotateLine(currentPath, start, end)
            },
          })
        : h(DiffPane, {
            files: changedFiles,
            path: activeFile,
            detail: diff.value,
            loading: diff.loading,
            busy,
            changedSet,
            onPickFile: (path) => {
              setActiveFile(path)
              setLeftTab('diff')
            },
            onDecide: (accept, reject) => { void decide(accept, reject) },
            onUndo: () => { void undoDecision() },
            onJumpSource: (line) => {
              setLeftTab('source')
              setActiveLine(line)
              if (activeFile !== null) {
                pendingLine.current = line
                void revealInPdf(activeFile, line)
              }
            },
            onComment: (index) => { setCommentFor(index); setCommentText('') },
            commentFor,
            commentText,
            setCommentText,
            onSubmitComment: () => { void submitComment() },
            onCancelComment: () => { setCommentFor(null); setCommentText('') },
            wrap: wrapSource,
            onToggleWrap: toggleWrap,
          })

      const pdfBody = (() => {
        if (status === null) return h('div', { className: 'blx-empty' }, '…')
        if (status.pdf === null) return h('div', { className: 'blx-empty' }, T('noPdf'))
        if (pdf?.fallback === true) {
          return h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 } },
            h('div', { className: 'blx-empty', style: { padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
              `PDF 用内嵌查看器显示：pdf.js 未就绪，点击定位/批注暂不可用。${pdfError === null ? '' : `（${pdfError}）`}`,
              h('button', {
                type: 'button',
                className: 'blx-btn',
                style: { marginLeft: '8px' },
                onClick: () => setPdfRetry((value) => value + 1),
              }, '重试'),
            ),
            h('iframe', {
              src: pdfUrl(sessionId, status?.rev, 'current'),
              title: 'PDF',
              style: { flex: '1 1 auto', minHeight: 0, width: '100%', height: '100%', border: '0', background: '#fff' },
            }),
          )
        }
        if (pdf === null || pdf?.doc === null || pdf?.doc === undefined) {
          return h('div', { className: 'blx-empty' }, pdfError ?? '…')
        }
        const pages = []
        const total = Math.min(pdf.numPages ?? 0, MAX_PAGES)
        for (let index = 1; index <= total; index += 1) {
          pages.push(h(PdfPageView, {
            key: index,
            doc: pdf.doc,
            pageNumber: index,
            width: pdfWidth * zoom,
            notes,
            draftRect: dragRect,
            activeNoteId: draft?.id ?? null,
            flash,
            registerRef: (pageNumber, node) => { pageRefs.current.set(pageNumber, node) },
            onDraftMove: (pageNumber, rect) => {
              setDragRect(rect === null ? null : { page: pageNumber, rect })
            },
            onDraftEnd: (pageNumber, rect) => {
              setDragRect(null)
              void openDraftFromRect(pageNumber, rect)
            },
            onOpenNote: (note) => {
              setDraft({ id: note.id, page: note.page, rect: note.rect, text: note.note, source: sourceOfNote(note), groups: [] })
              setCurrentPage(note.page)
            },
            onPickPoint: (pageNumber, nx, ny) => { void pickPoint(pageNumber, nx, ny) },
            onAnnotatePoint: (pageNumber, nx, ny) => { annotatePoint(pageNumber, nx, ny) },
            annotateMode,
          }))
        }
        return h('div', { className: 'blx-pdf', ref: pdfScrollRef },
          h('div', { className: 'blx-pages' }, pages,
            (pdf.numPages ?? 0) > MAX_PAGES ? h('div', { className: 'blx-note2' }, `仅渲染前 ${MAX_PAGES} 页`) : null,
          ),
        )
      })()

      const rightPane = h(
        'div',
        { className: 'blx-pane blx-pane-right', style: rightStyle },
        h(
          'div',
          { className: 'blx-pane-head' },
          h('span', { className: 'blx-pane-title' }, 'PDF'),
          h('span', { className: 'blx-badge blx-mini' }, `${currentPage}/${pdf?.numPages ?? status?.pdf?.pages ?? 0}`),
          h('button', {
            type: 'button',
            className: 'blx-btn',
            'data-active': String(annotateMode),
            onClick: () => setAnnotateMode((value) => !value),
            title: T('annotateHint'),
          }, `✎ ${T('annotateToggle')}`),
          h('span', { className: 'blx-grow' }),
          h('button', { type: 'button', className: 'blx-btn', onClick: () => setZoom((value) => Math.max(0.5, Number((value - 0.1).toFixed(2)))), title: '−' }, '−'),
          h('button', { type: 'button', className: 'blx-btn', onClick: () => setZoom(1), title: T('fitWidth') }, `${Math.round(zoom * 100)}%`),
          h('button', { type: 'button', className: 'blx-btn', onClick: () => setZoom((value) => Math.min(2.4, Number((value + 0.1).toFixed(2)))), title: '＋' }, '＋'),
        ),
        pdfBody,
        h('div', { className: 'blx-pdf-hint' }, `${CLIENT_VERSION} · ${T('pdfHint')}`),
      )

      const body = (() => {
        if (noToolchain) return h('div', { className: 'blx-empty' }, T('noToolchain'))
        if (noMain) return h('div', { className: 'blx-empty' }, T('noProject'), h('div', { className: 'blx-dim' }, T('openHint')))
        return h(
          'div',
          { className: 'blx-body', ref: bodyRef },
          h('div', { className: 'blx-pane blx-pane-left', style: leftStyle }, leftHead, leftBody),
          layout === 'split'
            ? h('div', {
                className: 'blx-divider',
                'data-drag': String(dragging),
                onPointerDown: onDividerDown,
                title: '拖动调整宽度',
              })
            : null,
          rightPane,
        )
      })()

      const statusText = status?.state === 'compiling'
        ? T('compiling')
        : status?.state === 'ok'
          ? `✓ ${status?.durationMs ? `${(status.durationMs / 1000).toFixed(1)}s` : ''}${status?.pdf?.pages ? ` · ${status.pdf.pages}${T('page')}` : ''}`
          : status?.state === 'error' || status?.state === 'timeout'
            ? `✗ ${(status?.errors ?? []).length}`
            : T('tabTitle')

      return h(
        'div',
        {
          className: 'blx-root',
          style: { '--blx-code-font': CODE_FONTS[codeFont], '--blx-code-size': `${codeSize}px` },
        },
        h(
          'div',
          { className: 'blx-bar' },
          h('span', { className: 'blx-badge' }, h('span', { className: 'blx-dot', 'data-state': status?.state ?? 'idle' }), statusText),
          changedFiles.length > 0
            ? h('button', {
                type: 'button',
                className: 'blx-btn',
                'data-variant': leftTab === 'diff' ? 'soft' : undefined,
                onClick: () => {
                  setLeftTab('diff')
                  if (layout === 'pdf') chooseLayout('split')
                },
                title: `${changedFiles.length} 个文件有改动`,
              }, `${T('reviewChip')} ${changedFiles.length}`)
            : null,
          h('span', { className: 'blx-grow' }),
          h('button', {
            type: 'button',
            className: 'blx-btn',
            'data-variant': 'primary',
            disabled: busy || status?.state === 'compiling',
            onClick: () => { void runCompile() },
          }, busy || status?.state === 'compiling' ? T('compiling') : `⟳ ${T('compile')}`),
          h('button', {
            type: 'button',
            className: 'blx-btn',
            title: T('fullscreen'),
            onClick: () => { try { ctx.get('layout')?.openRightbar?.(true, true) } catch { /* 忽略 */ } },
          }, '⤢'),
        ),
        h(
          'div',
          { className: 'blx-bar blx-bar-sub' },
          h('select', { className: 'blx-sel', value: status?.engine ?? 'pdflatex', onChange: (event) => { void changeEngine(event.target.value) }, title: T('engine') },
            ['pdflatex', 'xelatex', 'lualatex'].map((name) => h('option', { key: name, value: name }, name))),
          candidates.length > 0
            ? h('select', { className: 'blx-sel', value: status?.mainFile ?? candidates[0], onChange: (event) => { void changeMainFile(event.target.value) }, title: T('mainFile') },
                candidates.map((name) => h('option', { key: name, value: name }, name)))
            : null,
          h('button', { type: 'button', className: 'blx-btn', 'data-active': String(status?.settings?.autoCompile === true), onClick: () => { void toggleAuto() }, title: T('auto') }, T('auto')),
          h('button', {
            type: 'button',
            className: 'blx-btn',
            'data-active': String(showCodeCfg),
            onClick: () => setShowCodeCfg((value) => !value),
            title: T('codeStyle'),
          }, 'Aa'),
          h('span', { className: 'blx-grow' }),
          h(Seg, {
            value: layout,
            onChange: chooseLayout,
            options: [
              { value: 'split', label: T('layoutSplit'), title: T('layoutSplit') },
              { value: 'source', label: T('layoutSource'), title: T('layoutSource') },
              { value: 'pdf', label: T('layoutPdf'), title: T('layoutPdf') },
            ],
          }),
        ),
        showCodeCfg
          ? h(
              'div',
              { className: 'blx-bar blx-bar-sub blx-srccfg' },
              h('span', { className: 'blx-dim' }, T('codeFont')),
              h('select', {
                className: 'blx-sel',
                value: codeFont,
                onChange: (event) => chooseFont(event.target.value),
                title: T('codeFont'),
              }, Object.keys(CODE_FONTS).map((key) =>
                h('option', { key, value: key }, key === 'auto' ? `${T('fontAuto')} · ${CODE_FONT_NAMES[key]}` : CODE_FONT_NAMES[key]))),
              h('span', { className: 'blx-dim' }, T('fontSize')),
              h('button', { type: 'button', className: 'blx-btn', disabled: codeSize <= CODE_SIZE_MIN, onClick: () => stepSize(-1), title: '−' }, '−'),
              h('span', { className: 'blx-badge blx-mini' }, `${codeSize}px`),
              h('button', { type: 'button', className: 'blx-btn', disabled: codeSize >= CODE_SIZE_MAX, onClick: () => stepSize(1), title: '＋' }, '＋'),
              h('button', {
                type: 'button',
                className: 'blx-btn',
                'data-active': String(wrapSource),
                onClick: toggleWrap,
                title: T('wrapHint'),
              }, `↵ ${T('wrap')}`),
            )
          : null,
        body,
        resolvingRange
          ? h('div', { className: 'blx-tray blx-dim blx-row' },
              h('span', { className: 'blx-spinner' }),
              h('span', null, T('resolvingRange')))
          : null,
        draft !== null
          ? h(
              'div',
              { className: 'blx-tray' },
              h(
                'div',
                { className: 'blx-draftbox' },
                h(
                  'div',
                  { className: 'blx-draft-head' },
                  h('span', { className: 'blx-mono blx-dim' },
                    draft.source === null || draft.source === undefined
                      ? `${T('page')} ${draft.page} · ${T('noAnchor')}`
                      : anchorLabel(draft.source.file, draft.source.line, draft.source.endLine)),
                  draft.source !== null && draft.source !== undefined
                    && (Number(draft.source.endLine) || 0) > (Number(draft.source.line) || 0)
                    ? h('span', { className: 'blx-badge blx-mini' },
                        fmt(T('rangeLines'), draft.source.endLine - draft.source.line + 1))
                    : null,
                ),
                Array.isArray(draft.groups) && draft.groups.length > 1
                  ? h(
                      'div',
                      { className: 'blx-selchips' },
                      h('span', { className: 'blx-dim blx-mini' }, T('pickRange')),
                      draft.groups.map((group) =>
                        h('button', {
                          key: `${group.file}:${group.line}`,
                          type: 'button',
                          className: 'blx-chip',
                          'data-active': String(group.file === draft.source?.file && group.line === draft.source?.line),
                          onClick: () => { void pickGroup(group) },
                        }, h('span', { className: 'blx-chip-id' },
                          anchorLabel(group.file, group.line, group.endLine).slice(1))),
                      ),
                    )
                  : null,
                draft.source !== null && draft.source !== undefined && draft.source.quote !== ''
                  ? h(
                      'details',
                      { className: 'blx-quotebox' },
                      h('summary', null,
                        `${T('quoteTitle')} · ${fmt(T('rangeLines'), String(draft.source.quote).split(/\r?\n/).length)}`),
                      h('div', { className: 'blx-quote' }, draft.source.quote),
                    )
                  : null,
                h('textarea', {
                  value: draft.text,
                  onChange: (event) => setDraft({ ...draft, text: event.target.value }),
                  placeholder: T('notePlaceholder'),
                  autoFocus: true,
                }),
                h('div', { className: 'blx-row' },
                  h('button', { type: 'button', className: 'blx-btn', 'data-variant': 'primary', onClick: () => { void commitDraft() } }, T('addNote')),
                  h('button', { type: 'button', className: 'blx-btn', onClick: () => setDraft(null) }, T('cancel')),
                  draft.id === null ? null : h('button', { type: 'button', className: 'blx-btn', 'data-variant': 'no', onClick: () => { void deleteDraft() } }, T('deleteNote')),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'blx-tray' },
          h('div', { className: 'blx-row' },
            h('span', { className: 'blx-dim blx-grow' }, notes.length === 0 ? T('emptyTray') : `${notes.length} ${T('notes')}`),
            h('button', { type: 'button', className: 'blx-btn', 'data-variant': 'primary', disabled: notes.length === 0, onClick: () => { void sendNotes() } }, T('sendNotes')),
            h('button', { type: 'button', className: 'blx-btn', disabled: notes.length === 0, onClick: () => { void saveNotes([]) } }, T('clearNotes')),
          ),
          notes.length > 0
            ? h('div', { className: 'blx-chips' },
                notes.map((note) =>
                  h('button', {
                    key: note.id,
                    type: 'button',
                    className: 'blx-chip',
                    onClick: () => {
                      const anchor = sourceOfNote(note)
                      setDraft({ id: note.id, page: note.page, rect: note.rect, text: note.note, source: anchor, groups: [] })
                      if (anchor !== null) setSrcSel(anchor)
                      setCurrentPage(note.page)
                      scrollPdfTo(note.page, note.rect?.y ?? 0)
                    },
                    title: note.note,
                  },
                    h('span', { className: 'blx-chip-id' }, note.file === null || note.file === undefined
                      ? `p${note.page}`
                      : (Number(note.endLine) || 0) > (Number(note.line) || 0)
                        ? `L${note.line}–${note.endLine}`
                        : `L${note.line}`),
                    h('span', { className: 'blx-mini' }, note.note),
                  ),
                ),
              )
            : null,
        ),
        failure !== null ? h('div', { className: 'blx-tray blx-err' }, failure) : null,
        notice !== null ? h('div', { className: 'blx-tray blx-dim' }, notice) : null,
        (status?.errors ?? []).length > 0
          ? h('div', { className: 'blx-tray blx-err', style: { maxHeight: 90, overflow: 'auto' } },
              (status.errors ?? []).slice(0, 3).map((entry, index) => h('div', { key: index, className: 'blx-mono' },
                `${entry.line > 0 ? `${entry.file}:${entry.line}` : entry.file} — ${entry.message}`)))
          : null,
      )
    }

    function HeaderButton(props) {
      const ctx = props.ctx
      return h(
        'button',
        {
          type: 'button',
          className: 'blx-btn',
          title: T('tabDesc'),
          onClick: () => {
            try {
              ctx.get('sidebarRight')?.openTab?.(TAB_KIND, { revealIfOpened: true })
            } catch {
              // 忽略
            }
          },
          style: { display: 'inline-flex', alignItems: 'center', gap: 4 },
        },
        h(Icon, { size: 14 }),
        h('span', null, T('tabTitle')),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => installStyles(), 'dsh-side-tex: styles')

        ctx.inject(['sidebarRightTabs', 'sidebarRight'], (injected) => {
          const tabs = injected.get('sidebarRightTabs')
          if (tabs === undefined || typeof tabs.register !== 'function') return undefined
          const disposers = []
          try {
            disposers.push(tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              keepMounted: true,
              title: () => T('tabTitle'),
              guide: [{
                id: 'latex',
                order: 40,
                title: () => T('tabTitle'),
                description: () => T('tabDesc'),
                icon: (iconProps) => h(Icon, { size: iconProps?.size ?? 16 }),
              }],
            }))
            disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                { name: 'sidebar.right.pane.tab', key: TAB_ID, inject: (sessionId) => ({ ctx, sessionId }) },
                LatexTabSafe,
              ),
            ))
            disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, () => T('tabTitle')),
            ))
          } catch (error) {
            for (const dispose of disposers.reverse()) {
              try { dispose() } catch {}
            }
            throw error
          }
          return () => {
            for (const dispose of disposers.reverse()) {
              try { dispose() } catch {}
            }
          }
        })

        ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.actions', id: 'side-tex', order: 30, label: () => T('tabTitle'), inject: () => ({ ctx }) },
            HeaderButton,
          ),
        ), 'dsh-side-tex: header action')
      },
    }
  },
})
