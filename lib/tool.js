/**
 * 模型侧工具：latex_compile 与 latex_review。
 *
 * 方法：直接调用 ctx.tools.register 注册"原始工具定义"（name/description/parameters 原始
 *      JSON Schema/output{schema,render}/execute），不 import @deepseek-ai/dsh-tools
 *      ——profile 插件的动态 import 解析不到该包（静态 import 由宿主加载器映射，动态不行）。
 *      cwd 取自调用会话（exec.agent.session.header.cwd），模型无需传 sessionId。
 * 对象：一个 LaTeX 项目的一次编译，以及"基线 vs 工作副本"的变更审阅。
 *
 * 注册失败会写 ~/.dsh/side-tex-tools.log。
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 诊断日志。 */
const LOG_PATH = join(homedir(), '.dsh', 'side-tex-tools.log')

/** 追加一行诊断日志（失败静默）。 */
function log(message) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // 日志不可写时不影响功能
  }
}

/** 文本内容块。 */
const textBlock = (text) => ({ type: 'text', text })

/**
 * 取调用会话的工作目录。
 * @param {object} exec - 工具执行上下文
 * @param {object} ctx - 插件宿主上下文
 * @returns {string} 绝对工作目录
 */
function cwdOf(exec, ctx) {
  const session = exec?.agent?.session
  if (typeof session?.header?.cwd === 'string' && session.header.cwd !== '') return session.header.cwd
  const sessions = ctx.get('sessions')
  const live = session?.id === undefined ? undefined : sessions?.get?.(session.id)
  const workingDirectory = ctx.get('workingDirectory')
  const resolved = live === undefined ? undefined : workingDirectory?.get?.(live) ?? live.header?.cwd
  if (typeof resolved === 'string' && resolved !== '') return resolved
  const fallback = workingDirectory?.defaultDirectory
  if (typeof fallback === 'string' && fallback !== '') return fallback
  throw new Error('无法确定会话工作目录')
}

/** 编译结果 → 给模型看的文本。 */
function textOfCompile(result) {
  if (result === null || typeof result !== 'object') return '编译结果不可读'
  if (result.ok === true) {
    const pages = typeof result.pages === 'number' ? `${result.pages} 页` : '页数未知'
    const seconds = typeof result.durationMs === 'number' ? `${(result.durationMs / 1000).toFixed(1)}s` : ''
    const sync = result.syncCheck?.roundTrip === true ? '，SyncTeX 往返正常' : ''
    const changed = result.changes?.count > 0 ? `\n未审阅改动：${result.changes.count} 个文件（用户可在右侧栏「变更」里接受/放弃）` : ''
    return `✅ 编译成功（${result.engine ?? 'latexmk'}，${pages}${seconds === '' ? '' : '，' + seconds}）${sync}${changed}`
  }
  const lines = [`❌ 编译失败（${result.state ?? 'error'}）`]
  for (const entry of (result.errors ?? []).slice(0, 8)) {
    const location = entry.line > 0 ? `${entry.file}:${entry.line}` : entry.file
    lines.push(`${location}: ${entry.message}`)
  }
  if ((result.errors ?? []).length > 8) lines.push(`… 其余 ${result.errors.length - 8} 条错误见 LaTeX 标签页`)
  if (result.logTail) {
    const tail = String(result.logTail).trim().split(/\r\n|\n|\r/).slice(-6).join('\n')
    if (tail !== '') lines.push(`日志尾部：\n${tail}`)
  }
  return lines.join('\n')
}

/** 审阅结果 → 给模型看的文本。 */
function textOfReview(value) {
  if (value === null || typeof value !== 'object') return '审阅结果不可读'
  if (typeof value.summary === 'string') return value.summary
  if (Array.isArray(value.files)) {
    if (value.files.length === 0) return '没有未审阅的改动'
    const lines = [`未审阅改动 ${value.files.length} 个文件：`]
    for (const file of value.files.slice(0, 20)) {
      lines.push(`- ${file.path}（${file.status}，+${file.additions}/-${file.deletions}）`)
    }
    return lines.join('\n')
  }
  if (Array.isArray(value.hunks)) {
    const lines = [`${value.path}（${value.status}，+${value.additions}/-${value.deletions}）`]
    for (const hunk of value.hunks.slice(0, 6)) {
      lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
      for (const line of hunk.body.slice(0, 40)) {
        lines.push(`${line.type === '=' ? ' ' : line.type}${line.text}`)
      }
    }
    if (value.hunks.length > 6) lines.push(`… 其余 ${value.hunks.length - 6} 段见 LaTeX 标签页`)
    return lines.join('\n')
  }
  if (Array.isArray(value.rejected) || Array.isArray(value.accepted) || Array.isArray(value.conflicts)) {
    const parts = []
    if (value.accepted?.length) parts.push(`已接受 ${value.accepted.length} 个文件的改动`)
    if (value.rejected?.length) parts.push(`已放弃 ${value.rejected.length} 个文件的改动并恢复原版`)
    if (value.conflicts?.length) parts.push(`冲突未处理：${value.conflicts.join(', ')}`)
    return parts.join('；') || '没有变化'
  }
  return JSON.stringify(value)
}

/** 任意 JSON 值的输出 schema（内容由 render 决定）。 */
const ANY_OUTPUT = { type: 'object', additionalProperties: true }

/**
 * 注册两个工具。
 * @param {{ctx:object,store:object,tools:object,config:object}} input
 * @returns {Promise<() => void>} 注销函数
 */
export async function registerTools({ ctx, store, tools, config }) {
  log('registerTools: start')
  if (tools === undefined || typeof tools.register !== 'function') {
    log('skip: tools.register missing')
    return () => {}
  }
  const disposers = []
  const install = (label, definition) => {
    try {
      disposers.push(tools.register(definition))
      log(`${label}: register ok`)
    } catch (error) {
      log(`${label}: register failed: ${error instanceof Error ? error.stack : String(error)}`)
    }
  }

  install('latex_compile', {
    name: 'latex_compile',
    description:
      "Compile the LaTeX project in the calling session's working directory with latexmk and return pages, duration, "
      + 'and errors as file:line: message. The plugin already recompiles automatically after .tex edits, so call this when '
      + 'you want the authoritative result after a batch of edits. The compiled PDF is previewed live in the right sidebar '
      + 'LaTeX tab; never run pdflatex/latexmk yourself.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mainFile: { type: 'string', description: 'Optional project-relative main .tex file (auto-detected when omitted).' },
        engine: { type: 'string', description: "Optional engine: 'pdflatex' (default), 'xelatex' or 'lualatex'." },
        clean: { type: 'boolean', description: 'Remove aux files before compiling (latexmk -C) when true.' },
      },
    },
    output: {
      schema: ANY_OUTPUT,
      render: (_args, value) => [textBlock(textOfCompile(value))],
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const cwd = cwdOf(exec, ctx)
      const project = await store.ensure(cwd)
      if (typeof args.mainFile === 'string' && args.mainFile.trim() !== '') {
        await store.setMainFile(project, args.mainFile.trim())
      }
      if (typeof args.engine === 'string' && args.engine.trim() !== '') {
        await store.updateSettings(project, { engine: args.engine.trim() })
      }
      const result = await store.compile(project, { reason: 'tool', clean: args.clean === true, signal: exec?.signal })
      const changes = await store.changesOf(project)
      return {
        ...result,
        mainFile: project.mainFileRel,
        engine: project.settings.engine,
        syncCheck: project.syncCheck,
        changes: {
          count: changes.count,
          files: changes.files.slice(0, 10).map((file) => ({
            path: file.path,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
          })),
        },
      }
    },
  })

  install('latex_review', {
    name: 'latex_review',
    description:
      'Review changes to tracked LaTeX sources since the last accepted baseline: '
      + "'list' the changed files, 'diff' one file as unified hunks, 'review' the typeset-anchor summary for one file "
      + "(page rectangles in the accepted/current PDFs), 'accept'/'reject' one file or one hunk, 'undo' the last decision. "
      + 'accept/reject/undo are USER decisions: call them only when the user explicitly asks to keep or undo those edits; '
      + 'otherwise just report the list so the user can decide in the right sidebar LaTeX tab.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: "One of 'list', 'diff', 'review', 'accept', 'reject', 'undo'." },
        path: { type: 'string', description: "Project-relative file path (required for 'diff' and for hunk decisions)." },
        paths: { type: 'string', description: "Comma-separated project-relative paths (required for file-level 'accept'/'reject')." },
        hunks: { type: 'string', description: "Comma-separated hunk indexes (0-based) for a per-change decision together with path." },
      },
      required: ['action'],
    },
    output: {
      schema: ANY_OUTPUT,
      render: (_args, value) => [textBlock(textOfReview(value))],
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const cwd = cwdOf(exec, ctx)
      const project = await store.ensure(cwd)
      const action = typeof args.action === 'string' ? args.action : 'list'
      const splitPaths = () => {
        if (typeof args.paths === 'string' && args.paths.trim() !== '') {
          return args.paths.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
        }
        if (typeof args.path === 'string' && args.path.trim() !== '') return [args.path.trim()]
        return []
      }
      if (action === 'list') {
        const changes = await store.changesOf(project)
        return { files: changes.files }
      }
      if (action === 'diff') {
        const path = typeof args.path === 'string' ? args.path : ''
        if (path === '') throw new Error('latex_review diff 需要 path')
        return await project.review.diff(path)
      }
      const paths = splitPaths()
      const hunkList = typeof args.hunks === 'string' && args.hunks.trim() !== ''
        ? args.hunks.split(',').map((entry) => Number.parseInt(entry.trim(), 10)).filter((value) => Number.isInteger(value) && value >= 0)
        : []
      /**
       * 决策/撤销的返回值统一包成对象：工具输出 schema 要求 object，
       * 直接返回字符串会被宿主以 `"value" must be an object` 拒绝。
       */
      const summarized = async (value) => ({ summary: textOfReview(value), changes: (await store.changesOf(project)).files })
      if (action === 'undo') return summarized(await store.undo(project))
      if (action === 'accept' || action === 'reject') {
        if (hunkList.length > 0) {
          const hunkPath = typeof args.path === 'string' ? args.path.trim() : paths[0]
          if (hunkPath === undefined || hunkPath === '') throw new Error(`latex_review ${action} 需要 path`)
          const decision = action === 'accept' ? { accept: hunkList, reject: [] } : { accept: [], reject: hunkList }
          return summarized(await store.decide(project, hunkPath, decision))
        }
        if (paths.length === 0) throw new Error(`latex_review ${action} 需要 paths`)
        if (action === 'accept') return summarized(await store.acceptFiles(project, paths))
        return summarized(await store.rejectFiles(project, paths))
      }
      throw new Error(`未知 action: ${action}`)
    },
  })

  log(`registerTools: done, installed ${disposers.length}`)
  void config
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // 忽略注销失败
      }
    }
  }
}
