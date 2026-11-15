/**
 * 项目状态中心：按工作目录维护一个 LaTeX 项目的设置、编译状态、监视器与审阅器。
 *
 * 方法：项目以绝对 cwd 为键惰性创建；创建时探测工具链、读 settings、初始化变更基线、
 *      启动文件监视；编译任务串行排队（同一时刻只跑一个 latexmk）。
 * 对象：一个 LaTeX 项目（主文件、编译产物、错误列表、变更集合）。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  compileArgv,
  killTree,
  parseLatexLog,
  probeToolchain,
  readLogFile,
  runCompile,
  statArtifacts,
  tailOf,
} from './compile.js'
import { createBaseline } from './baseline.js'
import { buildBaseline, CompareError } from './compare.js'
import { createReview } from './review.js'
import { createWatcher } from './watch.js'
import { forwardSearch, inverseSearch, inverseSearchRange, synctexVersion } from './synctex.js'
import { listSourceFiles, readTextFile, safeResolve } from './source-files.js'

/** 支持的引擎。 */
export const ENGINES = ['pdflatex', 'xelatex', 'lualatex']
/** 项目闲置多久后释放（毫秒）。 */
const IDLE_MS = 30 * 60 * 1000
/** 变更列表缓存时间（毫秒）。 */
const CHANGES_TTL = 700

/** 默认项目设置。 */
export const DEFAULT_SETTINGS = {
  mainFile: null,
  engine: 'pdflatex',
  autoCompile: true,
  debounceMs: 500,
  compileTimeoutMs: 180000,
  buildDir: '.dsh-latex/build',
  command: null,
  trackExts: ['.tex', '.bib', '.cls', '.sty', '.ltx'],
  maxReviewBytes: 2 * 1024 * 1024,
  systemPrompt: true,
}

/** 带错误码的插件错误。 */
export class ProjectError extends Error {
  /**
   * @param {string} code - 错误码
   * @param {string} message - 面向用户的说明
   */
  constructor(code, message) {
    super(message)
    this.name = 'ProjectError'
    this.code = code
  }
}

/**
 * 把用户/文件里的设置合并到默认值并做基本校验。
 * @param {object} [raw] - 原始设置
 * @returns {object} 规范化设置
 */
export function normalizeSettings(raw = {}) {
  const settings = { ...DEFAULT_SETTINGS }
  if (raw !== null && typeof raw === 'object') {
    if (typeof raw.mainFile === 'string' && raw.mainFile !== '') settings.mainFile = raw.mainFile
    if (ENGINES.includes(raw.engine)) settings.engine = raw.engine
    if (typeof raw.autoCompile === 'boolean') settings.autoCompile = raw.autoCompile
    if (Number.isFinite(raw.debounceMs)) settings.debounceMs = Math.min(5000, Math.max(100, Number(raw.debounceMs)))
    if (Number.isFinite(raw.compileTimeoutMs)) settings.compileTimeoutMs = Math.min(1800000, Math.max(5000, Number(raw.compileTimeoutMs)))
    if (typeof raw.buildDir === 'string' && raw.buildDir !== '' && !raw.buildDir.includes('..') && !isAbsolute(raw.buildDir)) {
      settings.buildDir = raw.buildDir.replace(/\\/g, '/')
    }
    if (Array.isArray(raw.command) && raw.command.length > 0 && raw.command.every((part) => typeof part === 'string')) {
      settings.command = raw.command.slice()
    }
    if (Array.isArray(raw.trackExts) && raw.trackExts.length > 0) {
      settings.trackExts = raw.trackExts.filter((ext) => typeof ext === 'string' && ext.startsWith('.')).map((ext) => ext.toLowerCase())
      if (settings.trackExts.length === 0) settings.trackExts = DEFAULT_SETTINGS.trackExts.slice()
    }
    if (Number.isFinite(raw.maxReviewBytes)) settings.maxReviewBytes = Math.min(16 * 1024 * 1024, Math.max(65536, Number(raw.maxReviewBytes)))
    if (typeof raw.systemPrompt === 'boolean') settings.systemPrompt = raw.systemPrompt
  }
  return settings
}

/**
 * 读项目设置。
 * @param {string} projectDir - `.dsh-latex` 目录
 * @returns {Promise<object>}
 */
export async function loadSettings(projectDir) {
  try {
    const text = await readFile(join(projectDir, 'settings.json'), 'utf8')
    return normalizeSettings(JSON.parse(text))
  } catch {
    return normalizeSettings({})
  }
}

/**
 * 写项目设置。
 * @param {string} projectDir - `.dsh-latex` 目录
 * @param {object} settings - 规范化之后的设置
 */
export async function saveSettings(projectDir, settings) {
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
}

/**
 * 判断一个 tex 文件是否是文档主文件（含 \documentclass）。
 * @param {string} abs - 绝对路径
 * @returns {Promise<boolean>}
 */
async function hasDocumentClass(abs) {
  try {
    const { text } = await readTextFile(abs, 256 * 1024)
    const stripped = text
      .split(/\r\n|\n|\r/)
      .filter((line) => !line.trimStart().startsWith('%'))
      .join('\n')
    return /\\documentclass\b/.test(stripped)
  } catch {
    return false
  }
}

/**
 * 探测项目主文件。
 * @param {string} root - 项目根
 * @param {object} settings - 项目设置
 * @returns {Promise<{mainFile:string|null,candidates:string[],reason?:string}>}
 */
export async function detectMainFile(root, settings) {
  if (typeof settings.mainFile === 'string') {
    const abs = safeResolve(root, settings.mainFile)
    if (abs !== null && existsSync(abs)) return { mainFile: settings.mainFile, candidates: [] }
  }
  const files = await listSourceFiles(root, { trackExts: ['.tex'], maxFiles: 400, maxDepth: 4 })
  const byRel = new Map(files.map((file) => [file.rel, file]))
  const preferred = ['main.tex', 'paper.tex', 'thesis.tex', 'article.tex']
  for (const name of preferred) {
    const hit = byRel.get(name)
    if (hit !== undefined && (await hasDocumentClass(hit.abs))) return { mainFile: hit.rel, candidates: [] }
  }
  const candidates = []
  for (const file of files) {
    if (await hasDocumentClass(file.abs)) candidates.push(file.rel)
  }
  if (candidates.length === 1) return { mainFile: candidates[0], candidates }
  if (candidates.length > 1) return { mainFile: candidates[0], candidates, reason: 'multiple' }
  if (files.length === 1) return { mainFile: files[0].rel, candidates }
  return { mainFile: null, candidates: files.map((file) => file.rel), reason: files.length === 0 ? 'empty' : 'ambiguous' }
}

/**
 * 在 git 仓库里把 `.dsh-latex/` 写进 `.git/info/exclude`（不改用户的 .gitignore）。
 * @param {string} root
 */
async function excludeBuildDir(root) {
  try {
    const gitDir = join(root, '.git')
    const info = await stat(gitDir)
    if (!info.isDirectory()) return
    const excludePath = join(gitDir, 'info', 'exclude')
    let text = ''
    try {
      text = await readFile(excludePath, 'utf8')
    } catch {
      text = ''
    }
    if (text.split(/\r\n|\n|\r/).some((line) => line.trim() === '.dsh-latex/')) return
    await mkdir(dirname(excludePath), { recursive: true })
    await writeFile(excludePath, `${text}${text.endsWith('\n') || text === '' ? '' : '\n'}.dsh-latex/\n`, 'utf8')
  } catch {
    // 不是 git 仓库就跳过
  }
}

/**
 * 创建项目状态中心。
 * @param {{texBin?:string, log?:(message:string)=>void}} options - 插件配置
 * @returns {object} 状态中心
 */
export function createProjectStore(options = {}) {
  /** cwd -> project */
  const projects = new Map()
  let toolchain = probeToolchain(options)
  let toolchainChecked = toolchain !== null
  const listeners = new Set()

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // 监听器异常不影响状态
      }
    }
  }

  const toolchainOf = () => {
    if (!toolchainChecked) {
      toolchainChecked = true
      toolchain = probeToolchain(options)
    }
    return toolchain
  }

  /** 编译 cwd：主文件所在目录（相对路径、\input、\includegraphics、bibtex 都按它解析）。 */
  const compileDirOf = (project) => (
    project.mainFileRel === null ? project.root : dirname(resolve(project.root, project.mainFileRel))
  )

  const pdfPathsOf = (project) => {
    const buildAbs = resolve(project.root, project.settings.buildDir)
    const stem = project.mainFileRel === null ? null : basename(project.mainFileRel).replace(/\.tex$/i, '')
    if (stem === null) return { buildAbs, pdfAbs: null, synctexAbs: null }
    return { buildAbs, pdfAbs: join(buildAbs, `${stem}.pdf`), synctexAbs: join(buildAbs, `${stem}.pdf.synctex.gz`) }
  }

  const emit = () => notify()

  const runCompileTask = async (project, taskOptions = {}) => {
    if (project.disposed) throw new ProjectError('disposed', '项目已释放')
    if (project.mainFileRel === null) {
      throw new ProjectError('no-main-file', '未找到主文件：请在 LaTeX 标签页选择或新建一个含 \\documentclass 的 .tex')
    }
    const tools = toolchainOf()
    if (tools === null) {
      throw new ProjectError('no-toolchain', '未找到 TeX 工具链：请安装 TeX Live 或在项目设置里指定 texBin')
    }
    project.toolchain = tools
    const { buildAbs, pdfAbs, synctexAbs } = pdfPathsOf(project)
    await mkdir(buildAbs, { recursive: true })
    const compileDir = compileDirOf(project)
    if (taskOptions.clean === true) {
      await runCompile({
        argv: [tools.latexmk, '-C', `-outdir=${buildAbs}`, basename(project.mainFileRel)],
        cwd: compileDir,
        timeoutMs: 60000,
      })
    }
    project.state = 'compiling'
    project.startedAt = Date.now()
    project.finishedAt = null
    project.errors = []
    project.warnings = []
    project.lastReason = taskOptions.reason ?? 'manual'
    emit()
    const argv = compileArgv({
      toolchain: tools,
      settings: project.settings,
      mainFileRel: project.mainFileRel,
      cwd: compileDir,
      outDirAbs: buildAbs,
    })
    const result = await runCompile({
      argv,
      cwd: compileDir,
      timeoutMs: project.settings.compileTimeoutMs,
      signal: taskOptions.signal,
      onSpawn: (child) => {
        project.child = child
      },
    })
    project.child = null
    const logPath = join(buildAbs, `${basename(project.mainFileRel).replace(/\.tex$/i, '')}.log`)
    const logText = await readLogFile(logPath)
    const parsed = parseLatexLog(`${result.stdout}\n${logText}`, {
      root: project.root,
      baseDir: compileDir,
      mainFileRel: project.mainFileRel,
    })
    const artifacts = pdfAbs === null ? { pdfSize: null, rev: null, synctex: false } : await statArtifacts({ pdfPath: pdfAbs, synctexPath: synctexAbs })
    project.durationMs = result.durationMs
    project.finishedAt = Date.now()
    project.pages = parsed.pages
    project.errors = parsed.errors
    project.warnings = parsed.warnings
    project.logTail = tailOf(`${result.stdout}\n${logText}`)
    project.pdfAbs = artifacts.pdfSize === null ? null : pdfAbs
    project.pdfSize = artifacts.pdfSize
    project.rev = artifacts.rev
    project.hasSynctex = artifacts.synctex
    project.watcherMode = project.watcher?.mode() ?? null
    if (result.timedOut) {
      project.state = 'timeout'
      project.errors = [{ file: project.mainFileRel, line: 0, message: `编译超时（>${project.settings.compileTimeoutMs}ms），已终止` }]
    } else if (typeof result.spawnError?.message === 'string') {
      project.state = 'error'
      project.errors = [{ file: project.mainFileRel, line: 0, message: result.spawnError.message }]
    } else if (result.code === 0 && artifacts.pdfSize !== null) {
      project.state = project.errors.length === 0 ? 'ok' : 'error'
    } else {
      project.state = 'error'
      if (project.errors.length === 0) {
        project.errors = [{
          file: project.mainFileRel,
          line: 0,
          message:
            result.code === 0
              ? 'latexmk 已退出但未生成 PDF（检查主文件、引擎或日志尾部）'
              : `latexmk 退出码 ${result.code ?? '未知'}（详见日志）`,
        }]
      }
    }
    // pdflatex 不能直接排版中文正文：给出可执行的下一步提示。
    if (
      project.state === 'error' &&
      project.settings.engine === 'pdflatex' &&
      project.errors.some((entry) => entry.message.startsWith('Unicode character'))
    ) {
      project.errors.push({
        file: project.mainFileRel,
        line: 0,
        message: '文档含非 ASCII 正文：把引擎切换为 xelatex 并加载 \\usepackage{ctex}（中文）或相应字体宏包。',
      })
    }
    project.hasCompiled = true
    project.lastActivity = Date.now()
    // 首次成功编译后跑一次 SyncTeX 往返自检（证明双向链路可用）。
    if (project.state === 'ok' && !project.syncCheck && tools.synctex !== null && project.pdfAbs !== null) {
      project.syncCheck = await runSyncCheck(project)
    }
    emit()
    return {
      ok: project.state === 'ok',
      state: project.state,
      durationMs: project.durationMs,
      pages: project.pages,
      errors: project.errors,
      warnings: project.warnings,
      rev: project.rev,
      pdfPath: project.pdfAbs === null ? null : project.settings.buildDir + '/' + basename(project.pdfAbs),
    }
  }

  const runSyncCheck = async (project) => {
    const bin = project.toolchain?.synctex
    if (bin === null || bin === undefined || project.pdfAbs === null) return { view: false, edit: false, roundTrip: false }
    const compileDir = compileDirOf(project)
    const view = await forwardSearch({
      bin,
      root: project.root,
      baseDir: compileDir,
      texFile: resolve(project.root, project.mainFileRel),
      pdfFile: project.pdfAbs,
      line: 1,
    })
    if (view === null) return { view: false, edit: false, roundTrip: false }
    const edit = await inverseSearch({
      bin,
      root: project.root,
      baseDir: compileDir,
      pdfFile: project.pdfAbs,
      page: view.page,
      x: view.x,
      y: view.y,
    })
    return {
      view: true,
      edit: edit !== null,
      roundTrip: edit !== null && edit.file === project.mainFileRel,
      version: synctexVersion(bin, project.root),
    }
  }

  const compile = (project, taskOptions = {}) => {
    const task = () => runCompileTask(project, taskOptions)
    const run = project.queue.then(task, task)
    project.queue = run.then(() => undefined, () => undefined)
    return run
  }

  const startWatcher = (project) => {
    if (project.watcher !== null) return
    project.watcher = createWatcher({
      root: project.root,
      exts: project.settings.trackExts,
      debounceMs: project.settings.debounceMs,
      onBatch: () => {
        project.lastActivity = Date.now()
        if (!project.settings.autoCompile) return
        if (!project.hasCompiled) return
        if (project.state === 'compiling') return
        void compile(project, { reason: 'watch' }).catch(() => {})
      },
      onError: (error) => {
        project.watchError = error instanceof Error ? error.message : String(error)
      },
    })
  }

  const ensure = async (cwd) => {
    const root = resolve(cwd)
    const existing = projects.get(root)
    if (existing !== undefined && !existing.disposed) {
      existing.lastActivity = Date.now()
      return existing
    }
    const projectDir = join(root, '.dsh-latex')
    const settings = await loadSettings(projectDir)
    const detection = await detectMainFile(root, settings)
    const baseline = createBaseline({ root, dir: join(projectDir, 'baseline') })
    await baseline.load()
    const initialFiles = []
    for (const file of await listSourceFiles(root, { trackExts: settings.trackExts, maxBytes: settings.maxReviewBytes })) {
      try {
        const { text } = await readTextFile(file.abs, settings.maxReviewBytes)
        initialFiles.push({ rel: file.rel, text, mtimeMs: file.mtimeMs })
      } catch {
        // 读不到就跳过
      }
    }
    await baseline.init(initialFiles)
    const review = createReview({ root, settings, baseline })
    const project = {
      root,
      projectDir,
      settings,
      mainFileRel: detection.mainFile,
      mainFileCandidates: detection.candidates,
      mainFileReason: detection.reason ?? null,
      toolchain: toolchainOf(),
      state: 'idle',
      rev: null,
      pdfAbs: null,
      pdfSize: null,
      pages: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      errors: [],
      warnings: [],
      logTail: '',
      syncCheck: null,
      hasSynctex: false,
      hasCompiled: false,
      lastReason: null,
      lastActivity: Date.now(),
      watcher: null,
      watcherMode: null,
      watchError: null,
      child: null,
      queue: Promise.resolve(),
      disposed: false,
      changesCache: { at: 0, value: { count: 0, files: [] } },
      baseline,
      review,
      /** 基线 PDF 对比状态（Papilot 式 before/after）。 */
      compare: { state: 'idle', key: null, pdfAbs: null, synctexAbs: null, src: null, rev: null, message: null },
      comparePromise: null,
      /** 决策撤销栈（内存，最多 20 步）。 */
      undoStack: [],
      /** 基线版本号：任何接受/决策都 +1，用于让审阅缓存失效。 */
      baselineVersion: 0,
      /** 审阅锚点缓存。 */
      reviewCache: { key: null, value: null },
    }
    projects.set(root, project)
    await excludeBuildDir(root)
    startWatcher(project)
    return project
  }

  const changesOf = async (project) => {
    const now = Date.now()
    if (now - project.changesCache.at < CHANGES_TTL) return project.changesCache.value
    const files = await project.review.changes()
    const value = { count: files.length, files }
    project.changesCache = { at: now, value }
    return value
  }

  // ── 基线 PDF 对比（Papilot 式 before/after）──────────────────────────
  const ensureCompare = (project) => {
    if (project.comparePromise !== null) return project.comparePromise
    if (project.compare.state === 'ready') return Promise.resolve(project.compare)
    project.comparePromise = (async () => {
      project.compare = { ...project.compare, state: 'building', message: null }
      emit()
      try {
        const built = await buildBaseline({ project })
        project.compare = {
          state: 'ready',
          key: built.key,
          pdfAbs: built.pdfAbs,
          synctexAbs: built.synctexAbs,
          src: built.src,
          rev: built.rev,
          message: null,
        }
        project.lastActivity = Date.now()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        project.compare = { state: 'error', key: null, pdfAbs: null, synctexAbs: null, src: null, rev: null, message }
        if (!(error instanceof CompareError)) {
          project.compare.state = 'error'
        }
      } finally {
        project.comparePromise = null
        emit()
      }
      return project.compare
    })()
    return project.comparePromise
  }

  /** 取一个源码行在给定 PDF 上的矩形（synctex 正查）。 */
  const anchorOf = async ({ bin, root, baseDir, texAbs, pdfAbs, line }) => {
    if (bin === null || bin === undefined || pdfAbs === null) return null
    const result = await forwardSearch({
      bin,
      root,
      baseDir,
      texFile: texAbs,
      pdfFile: pdfAbs,
      line: Math.max(1, line),
    })
    if (result === null) return null
    return {
      page: result.page,
      x: result.x,
      y: result.y,
      width: result.width,
      height: result.height,
    }
  }

  const reviewOf = async (project, relPath, { ensure = false } = {}) => {
    const cacheKey = `${project.rev ?? ''}|${project.baselineVersion}|${project.compare.state}|${project.compare.rev ?? ''}|${relPath}`
    if (project.reviewCache.key === cacheKey) return project.reviewCache.value
    const diff = await project.review.diff(relPath)
    if (diff === null) throw new ProjectError('bad-request', `未知文件: ${relPath}`)
    if (ensure && project.compare.state === 'idle') void ensureCompare(project)
    const bin = project.toolchain?.synctex ?? null
    const compareReady = project.compare.state === 'ready'
    const changes = []
    for (let index = 0; index < diff.hunks.length; index += 1) {
      const hunk = diff.hunks[index]
      const after = await anchorOf({
        bin,
        root: project.root,
        baseDir: compileDirOf(project),
        texAbs: resolve(project.root, relPath),
        pdfAbs: project.pdfAbs,
        line: hunk.newStart,
      })
      const before = compareReady
        ? await anchorOf({
            bin,
            root: project.compare.src,
            baseDir: dirname(resolve(project.compare.src, project.mainFileRel)),
            texAbs: resolve(project.compare.src, relPath),
            pdfAbs: project.compare.pdfAbs,
            line: hunk.oldStart,
          })
        : null
      const additions = hunk.body.filter((line) => line.type === '+').length
      const deletions = hunk.body.filter((line) => line.type === '-').length
      const firstChanged = hunk.body.find((line) => line.type !== '=') ?? hunk.body[0]
      changes.push({
        index,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        additions,
        deletions,
        headline: firstChanged === undefined ? '' : `${firstChanged.type === '+' ? '+' : firstChanged.type === '-' ? '-' : ' '}${firstChanged.text}`,
        before,
        after,
        sourceLines: {
          old: hunk.body.filter((line) => line.type !== '+').slice(0, 8).map((line) => line.text),
          new: hunk.body.filter((line) => line.type !== '-').slice(0, 8).map((line) => line.text),
        },
      })
    }
    const value = {
      path: relPath,
      status: diff.status,
      additions: diff.additions,
      deletions: diff.deletions,
      truncated: diff.truncated,
      currentMtimeMs: diff.currentMtimeMs,
      baseMtimeMs: diff.baseMtimeMs,
      hunks: diff.hunks,
      changes,
      compare: {
        state: project.compare.state,
        rev: project.compare.rev,
        message: project.compare.message,
      },
    }
    project.reviewCache = { key: cacheKey, value }
    return value
  }

  const decide = async (project, relPath, { accept = [], reject = [] } = {}) => {
    const abs = safeResolve(project.root, relPath)
    if (abs === null) throw new ProjectError('bad-request', '路径越界')
    const before = {
      working: await readFile(abs, 'utf8'),
      baseline: (await project.baseline.readText(relPath)) ?? null,
    }
    const info = await stat(abs)
    const result = await project.review.decide(relPath, { accept, reject })
    project.undoStack.push({ path: relPath, ...before, at: Date.now() })
    if (project.undoStack.length > 20) project.undoStack.shift()
    project.baselineVersion += 1
    project.reviewCache = { key: null, value: null }
    project.changesCache = { at: 0, value: project.changesCache.value }
    void info
    if (project.settings.autoCompile) {
      try {
        await compile(project, { reason: 'decide' })
      } catch {
        // 编译错误进状态
      }
    }
    return result
  }

  const undo = async (project) => {
    const entry = project.undoStack.pop()
    if (entry === undefined) throw new ProjectError('no-undo', '没有可撤销的决策')
    const abs = safeResolve(project.root, entry.path)
    if (abs === null) throw new ProjectError('bad-request', '路径越界')
    await writeFile(abs, entry.working, 'utf8')
    if (entry.baseline === null) await project.baseline.remove(entry.path)
    else await project.baseline.capture(entry.path, entry.baseline)
    await project.baseline.save()
    project.baselineVersion += 1
    project.reviewCache = { key: null, value: null }
    project.changesCache = { at: 0, value: project.changesCache.value }
    if (project.settings.autoCompile) {
      try {
        await compile(project, { reason: 'undo' })
      } catch {
        // 编译错误进状态
      }
    }
    return { path: entry.path, remaining: project.undoStack.length }
  }

  // ── 批注（notes.json）────────────────────────────────────────────────
  const notesPath = (project) => join(project.projectDir, 'notes.json')
  const readNotes = async (project) => {
    try {
      const text = await readFile(notesPath(project), 'utf8')
      const parsed = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.notes)) return parsed
    } catch {
      // 没有或损坏
    }
    return { version: 1, notes: [] }
  }
  const writeNotes = async (project, notes) => {
    const list = Array.isArray(notes) ? notes.slice(0, 200) : []
    const value = { version: 1, notes: list }
    await mkdir(project.projectDir, { recursive: true })
    const temp = `${notesPath(project)}.tmp`
    await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
    await (await import('node:fs/promises')).rename(temp, notesPath(project))
    return value
  }

  const statusOf = async (project, extra = {}) => {
    const tools = project.toolchain
    let changes = project.changesCache.value
    try {
      changes = await changesOf(project)
    } catch {
      // 变更读取失败不影响编译状态
    }
    return {
      cwd: project.root,
      toolchain: tools === null ? null : { binDir: tools.binDir, latexmk: tools.latexmk, synctex: tools.synctex, source: tools.source },
      mainFile: project.mainFileRel,
      mainFileCandidates: project.mainFileCandidates,
      mainFileReason: project.mainFileReason,
      engine: project.settings.engine,
      settings: {
        mainFile: project.settings.mainFile,
        engine: project.settings.engine,
        autoCompile: project.settings.autoCompile,
        debounceMs: project.settings.debounceMs,
        buildDir: project.settings.buildDir,
        trackExts: project.settings.trackExts,
      },
      state: project.state,
      rev: project.rev,
      pdf: project.pdfAbs === null ? null : {
        path: `${project.settings.buildDir.replace(/\\/g, '/')}/${basename(project.pdfAbs)}`,
        size: project.pdfSize,
        pages: project.pages,
      },
      startedAt: project.startedAt,
      finishedAt: project.finishedAt,
      durationMs: project.durationMs,
      errors: project.errors,
      warnings: project.warnings,
      logTail: project.logTail,
      syncCheck: project.syncCheck,
      hasSynctex: project.hasSynctex,
      watcher: project.watcher?.mode() ?? null,
      watchError: project.watchError,
      lastReason: project.lastReason,
      changes,
      compare: { state: project.compare.state, rev: project.compare.rev, message: project.compare.message },
      ...extra,
    }
  }

  const disposeProject = (project) => {
    project.disposed = true
    project.watcher?.close()
    project.watcher = null
    killTree(project.child)
    project.child = null
  }

  const idleTimer = setInterval(() => {
    const now = Date.now()
    for (const [root, project] of projects) {
      if (project.state === 'compiling') continue
      if (now - project.lastActivity < IDLE_MS) continue
      disposeProject(project)
      projects.delete(root)
    }
  }, 120000)
  idleTimer.unref?.()

  return {
    ensure,
    get: (cwd) => projects.get(resolve(cwd)) ?? null,
    list: () => [...projects.values()],
    statusOf,
    changesOf,
    compile,
    ensureCompare,
    reviewOf,
    decide,
    undo,
    readNotes,
    writeNotes,
    /** 逐文件接受（兼容旧调用/工具）。 */
    async acceptFiles(project, paths) {
      const result = await project.review.accept(paths)
      project.undoStack.length = 0
      project.baselineVersion += 1
      project.reviewCache = { key: null, value: null }
      project.changesCache = { at: 0, value: project.changesCache.value }
      return result
    },
    /** 逐文件放弃（兼容旧调用/工具）。 */
    async rejectFiles(project, paths, expectedMtimeMs) {
      const result = await project.review.reject(paths, expectedMtimeMs)
      project.undoStack.length = 0
      project.baselineVersion += 1
      project.reviewCache = { key: null, value: null }
      project.changesCache = { at: 0, value: project.changesCache.value }
      return result
    },
    /** 基线 PDF 的绝对路径（未就绪时 null）。 */
    baselinePdf(project) {
      return project.compare.state === 'ready' ? project.compare.pdfAbs : null
    },
    cancel(project) {
      killTree(project.child)
      project.child = null
    },
    async updateSettings(project, patch) {
      const next = normalizeSettings({ ...project.settings, ...patch })
      // 原地更新：review 创建时持有的是同一个 settings 引用（trackExts 等要跟着变）。
      Object.assign(project.settings, next)
      await saveSettings(project.projectDir, project.settings)
      if (patch.patchMainFile === false && project.settings.mainFile !== null) {
        const detection = await detectMainFile(project.root, project.settings)
        project.mainFileRel = detection.mainFile
        project.mainFileCandidates = detection.candidates
        project.mainFileReason = detection.reason ?? null
      }
      project.changesCache = { at: 0, value: project.changesCache.value }
      return project.settings
    },
    async setMainFile(project, mainFileRel) {
      const abs = safeResolve(project.root, mainFileRel)
      if (abs === null || !existsSync(abs)) throw new ProjectError('bad-request', `文件不存在: ${mainFileRel}`)
      Object.assign(project.settings, normalizeSettings({ ...project.settings, mainFile: mainFileRel }))
      await saveSettings(project.projectDir, project.settings)
      project.mainFileRel = mainFileRel
      project.mainFileReason = null
      return project.settings
    },
    async readSource(project, relPath, maxLines = 2000) {
      const target = relPath === undefined || relPath === null || relPath === '' ? project.mainFileRel : relPath
      if (target === null) throw new ProjectError('no-main-file', '未找到主文件')
      const abs = safeResolve(project.root, target)
      if (abs === null) throw new ProjectError('bad-request', '路径越界')
      const { text } = await readTextFile(abs, 4 * 1024 * 1024)
      const info = await stat(abs)
      const lines = text.split(/\r\n|\n|\r/)
      const truncated = lines.length > maxLines
      return {
        path: target,
        lines: truncated ? lines.slice(0, maxLines) : lines,
        total: lines.length,
        truncated,
        mtimeMs: info.mtimeMs,
      }
    },
    /**
     * 手动改源码：替换某一行的文本，写回磁盘（原子写 + mtime CAS）。
     * 基线不变，所以改动会出现在「改动」页签等待审阅；未开自动编译时后台补一次编译。
     * @param {object} project
     * @param {string|null|undefined} relPath
     * @param {number} line - 1 起的行号
     * @param {string} text - 新的单行内容（多行会被压成一行）
     * @param {number} [expectedMtimeMs] - 读取时的 mtime，用于冲突检测
     * @returns {Promise<{path:string,line:number,lines:string[],mtimeMs:number}>}
     */
    async writeLine(project, relPath, line, text, expectedMtimeMs) {
      const target = relPath === undefined || relPath === null || relPath === '' ? project.mainFileRel : relPath
      if (target === null) throw new ProjectError('no-main-file', '未找到主文件')
      const abs = safeResolve(project.root, target)
      if (abs === null) throw new ProjectError('bad-request', '路径越界')
      const before = await stat(abs).catch(() => null)
      if (before === null) throw new ProjectError('bad-request', `文件不存在: ${target}`)
      if (Number.isFinite(expectedMtimeMs) && Math.abs(before.mtimeMs - expectedMtimeMs) > 2) {
        throw new ProjectError('conflict', '文件在此期间被改动，已刷新')
      }
      const { text: raw } = await readTextFile(abs, 4 * 1024 * 1024)
      const eol = raw.includes('\r\n') ? '\r\n' : '\n'
      const hadTail = /\r?\n$/.test(raw)
      const lines = raw.split(/\r\n|\n|\r/)
      if (hadTail) lines.pop()
      const index = Math.max(1, Number(line) || 0) - 1
      if (index < 0 || index >= lines.length) throw new ProjectError('bad-request', `行号越界: ${line}`)
      lines[index] = String(text ?? '').replace(/[\r\n]+/g, ' ')
      const next = lines.join(eol) + (hadTail ? eol : '')
      const temp = `${abs}.dsh-latex.tmp`
      await writeFile(temp, next, 'utf8')
      await rename(temp, abs)
      const after = await stat(abs)
      project.changesCache = { at: 0, value: project.changesCache.value }
      // 编辑是明确意图：没开自动编译也补一次，让 PDF 跟上。
      if (project.settings.autoCompile !== true) {
        void compile(project, { reason: 'manual-edit' }).catch(() => {})
      }
      return { path: target, line: index + 1, lines, mtimeMs: after.mtimeMs }
    },
    async syncView(project, { file, line, column }) {
      const bin = project.toolchain?.synctex
      if (bin === null || bin === undefined) throw new ProjectError('no-synctex', '未找到 synctex')
      const pdfAbs = project.pdfAbs
      if (pdfAbs === null || !existsSync(pdfAbs)) throw new ProjectError('no-pdf', '还没有编译产物')
      const target = file === undefined || file === null || file === '' ? project.mainFileRel : file
      const result = await forwardSearch({
        bin,
        root: project.root,
        baseDir: compileDirOf(project),
        texFile: resolve(project.root, target),
        pdfFile: pdfAbs,
        line,
        column,
      })
      return result ?? { ok: false }
    },
    async syncEdit(project, { page, x, y }) {
      const bin = project.toolchain?.synctex
      if (bin === null || bin === undefined) throw new ProjectError('no-synctex', '未找到 synctex')
      const pdfAbs = project.pdfAbs
      if (pdfAbs === null || !existsSync(pdfAbs)) throw new ProjectError('no-pdf', '还没有编译产物')
      const result = await inverseSearch({
        bin,
        root: project.root,
        baseDir: compileDirOf(project),
        pdfFile: pdfAbs,
        page,
        x,
        y,
      })
      return result ?? { ok: false }
    },
    /**
     * PDF 上的一块矩形 → 源码行区间（拖框批注用）。
     * @param {object} project
     * @param {{page:number,x:number,y:number,w:number,h:number}} area - 单位 PDF 点
     */
    async syncRange(project, { page, x, y, w, h }) {
      const bin = project.toolchain?.synctex
      if (bin === null || bin === undefined) throw new ProjectError('no-synctex', '未找到 synctex')
      const pdfAbs = project.pdfAbs
      if (pdfAbs === null || !existsSync(pdfAbs)) throw new ProjectError('no-pdf', '还没有编译产物')
      const result = await inverseSearchRange({
        bin,
        root: project.root,
        baseDir: compileDirOf(project),
        pdfFile: pdfAbs,
        page,
        x,
        y,
        w,
        h,
      })
      return result ?? { ok: false }
    },
    async history(project) {
      return { entries: project.settings.command === null ? [] : [] }
    },
    dispose() {
      clearInterval(idleTimer)
      for (const project of projects.values()) disposeProject(project)
      projects.clear()
      listeners.clear()
    },
  }
}
