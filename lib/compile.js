/**
 * LaTeX 编译内核：工具链探测、latexmk 拉起、输出解码、日志解析。
 *
 * 方法：直接用 node:child_process 拉起 latexmk（与 dsh-better-sidebar 的 git/zip
 *      子进程同一做法）；stdout/stderr 以 Buffer 收集后按"UTF-8 严格 → GBK → latin1"
 *      依次解码（SyncTeX / TeX 在 Windows 上按系统 ANSI 代码页写路径，纯 UTF-8 解会乱码）。
 * 对象：一个项目（cwd + settings + 主文件）的一次编译；输出错误/警告列表与页数。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { readFile, mkdir, stat } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path'

/** 单次编译保留的输出上限（字节）。 */
const OUTPUT_CAP = 256 * 1024
/** 日志尾部保留长度（字符），给 UI 展开用。 */
const LOG_TAIL = 8192
/** 错误/警告列表上限。 */
const MAX_DIAGNOSTICS = 200

/** latexmk 的引擎开关。 */
const ENGINE_FLAG = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' }

/**
 * 解码子进程输出：先严格 UTF-8，失败再按 GBK，最后 latin1。
 * @param {Buffer} buffer - 原始字节
 * @returns {string} 文本
 */
export function decodeOutput(buffer) {
  if (buffer.length === 0) return ''
  for (const encoding of ['utf-8', 'gbk']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer)
    } catch {
      // 换下一种编码
    }
  }
  return buffer.toString('latin1')
}

/**
 * 探测本机 TeX 工具链：优先配置的目录，其次 TeX Live 年份目录、MiKTeX 常见位置、PATH。
 * @param {{texBin?:string}} [config] - 插件配置
 * @returns {{binDir:string,latexmk:string,pdflatex:string,xelatex:string,lualatex:string,
 *            synctex:string|null,biber:string|null,source:string}|null}
 */
export function probeToolchain(config = {}) {
  const dirs = []
  if (typeof config.texBin === 'string' && config.texBin !== '') dirs.push(config.texBin)
  for (const base of ['C:\\texlive', 'D:\\texlive']) {
    try {
      for (const name of readdirSync(base)) {
        if (!/^\d{4}$/.test(name)) continue
        dirs.push(join(base, name, 'bin', 'windows'))
        dirs.push(join(base, name, 'bin', 'win32'))
      }
    } catch {
      // 该盘没有 TeX Live
    }
  }
  const env = process.env
  if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'))
  dirs.push('C:\\Program Files\\MiKTeX\\miktex\\bin\\x64', 'C:\\texlive\\bin\\win32')
  for (const entry of String(env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (entry !== '') dirs.push(entry)
  }
  const seen = new Set()
  for (const dir of dirs) {
    if (typeof dir !== 'string' || dir === '' || seen.has(dir)) continue
    seen.add(dir)
    const latexmk = join(dir, 'latexmk.exe')
    if (!existsSync(latexmk)) continue
    const pick = (name) => {
      const candidate = join(dir, name)
      return existsSync(candidate) ? candidate : null
    }
    return {
      binDir: dir,
      latexmk,
      pdflatex: pick('pdflatex.exe'),
      xelatex: pick('xelatex.exe'),
      lualatex: pick('lualatex.exe'),
      synctex: pick('synctex.exe'),
      biber: pick('biber.exe'),
      source: config.texBin === dir ? 'config' : 'probe',
    }
  }
  return null
}

/**
 * 组装一次编译的 argv。
 * @param {{toolchain:object,settings:object,mainFileRel:string}} input
 * @returns {string[]} 参数数组（第 0 项为可执行文件）
 */
export function compileArgv({ toolchain, settings, mainFileRel, cwd, outDirAbs }) {
  if (Array.isArray(settings.command) && settings.command.length > 0) return settings.command.slice()
  const flag = ENGINE_FLAG[settings.engine] ?? '-pdf'
  // latexmk 统一负责引擎选择、rerun 与 -outdir；直接调 pdflatex 会丢掉这些语义
  // （pdflatex 只认 -output-directory，不认 latexmk 的 -outdir）。
  // 编译 cwd 取主文件所在目录（子目录主文件很常见）：这样 \input、\includegraphics、
  // ibliography 的相对路径与 bibtex 找 .bib 都按主文件目录解析。此时主文件参数只能是
  // 文件名，产物目录要传绝对路径（否则会落到主文件目录下的相对位置）。
  const inMainDir = typeof cwd === 'string' && cwd !== ''
  const outDir = typeof outDirAbs === 'string' && outDirAbs !== '' ? outDirAbs : settings.buildDir
  return [
    toolchain.latexmk,
    flag,
    '-interaction=nonstopmode',
    '-file-line-error',
    '-synctex=1',
    `-outdir=${outDir}`,
    inMainDir ? basename(mainFileRel) : mainFileRel,
  ]
}

/**
 * 杀掉一个子进程及其整棵进程树（Windows 用 taskkill /T，其它平台 SIGKILL）。
 * @param {import('node:child_process').ChildProcess|null} child
 */
export function killTree(child) {
  if (child === null || child === undefined) return
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      // taskkill 不可用时退回 child.kill
    }
  }
  try {
    child.kill()
  } catch {
    // 已退出
  }
}

/**
 * 拉起一次编译并收集输出。
 * @param {{argv:string[],cwd:string,timeoutMs:number,signal?:AbortSignal,
 *          onSpawn?:(child:any)=>void}} input
 * @returns {Promise<{code:number|null,timedOut:boolean,cancelled:boolean,
 *                    durationMs:number,stdout:string,stderr:string,spawnError?:Error}>}
 */
export function runCompile({ argv, cwd, timeoutMs, signal, onSpawn }) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now()
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({ code: null, timedOut: false, cancelled: false, durationMs: 0, stdout: '', stderr: '', spawnError: error })
      return
    }
    onSpawn?.(child)
    const chunks = []
    let collected = 0
    let timedOut = false
    let cancelled = false
    const collect = (chunk) => {
      if (collected >= OUTPUT_CAP) return
      const room = OUTPUT_CAP - collected
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
      chunks.push(slice)
      collected += slice.length
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, Math.max(1000, timeoutMs))
    const onAbort = () => {
      cancelled = true
      killTree(child)
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const settle = (code, extra) => {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      const raw = Buffer.concat(chunks)
      resolvePromise({
        code,
        timedOut,
        cancelled,
        durationMs: Date.now() - startedAt,
        stdout: decodeOutput(raw),
        stderr: '',
        ...extra,
      })
    }
    child.on('error', (error) => settle(null, { spawnError: error }))
    child.on('close', (code) => settle(typeof code === 'number' ? code : null, {}))
  })
}

/**
 * 解析 LaTeX 日志/输出里的错误、警告与页数。
 * @param {string} text - 已解码的输出（stdout 与 .log 可合并）
 * @param {{root:string,mainFileRel:string}} context
 * @returns {{errors:Array,warnings:Array,pages:number|null}}
 */
export function parseLatexLog(text, context) {
  const errors = []
  const warnings = []
  const seen = new Set()
  let pages = null
  const lines = String(text ?? '').split(/\r\n|\n|\r/)
  // 编译在主文件目录里跑时，日志里的路径相对那个目录；先按 baseDir 还原再归一化到项目根。
  const baseDir = typeof context.baseDir === 'string' && context.baseDir !== '' ? context.baseDir : context.root
  const toProjectRelative = (raw) => {
    if (typeof raw !== 'string' || raw === '') return raw
    return normalizeRelative(context.root, isAbsolute(raw) ? raw : resolve(baseDir, raw))
  }
  const fileLine = /^(?<file>.+?\.(?:tex|sty|cls|bib|def|cfg)):(?<line>\d+):\s*(?<message>.*)$/
  const overfull = /(?:Overfull|Underfull)\s+\\[hv]box\b.*?(?:at lines? (?<line>\d+)|detected at line (?<line2>\d+))/
  const warningOnInput = /on input line (\d+)/
  let pendingWarning = null
  const push = (list, entry) => {
    if (list.length >= MAX_DIAGNOSTICS) return
    const key = `${list === errors ? 'E' : 'W'}|${entry.file ?? ''}|${entry.line ?? 0}|${entry.message}`
    if (seen.has(key)) return
    seen.add(key)
    list.push(entry)
  }
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const line = raw.trimEnd()
    const pageMatch = /Output written on .*?\((\d+) pages?/.exec(line)
    if (pageMatch !== null) pages = Number(pageMatch[1])
    if (pendingWarning !== null) {
      const onInput = warningOnInput.exec(line)
      if (onInput !== null) {
        pendingWarning.line = Number(onInput[1])
        push(warnings, pendingWarning)
        pendingWarning = null
      } else if (line.trim() !== '') {
        push(warnings, pendingWarning)
        pendingWarning = null
      }
    }
    const fileMatch = fileLine.exec(line)
    if (fileMatch !== null && fileMatch.groups !== undefined) {
      const message = fileMatch.groups.message.trim()
      if (message !== '') {
        push(errors, {
          file: toProjectRelative(fileMatch.groups.file),
          line: Number(fileMatch.groups.line),
          message,
        })
      }
      continue
    }
    if (line.startsWith('! ')) {
      push(errors, { file: context.mainFileRel, line: 0, message: line.slice(2).trim() })
      continue
    }
    if (/^LaTeX Warning:/.test(line) || /^Package .+ Warning:/.test(line) || /^Class .+ Warning:/.test(line)) {
      pendingWarning = {
        file: context.mainFileRel,
        line: 0,
        message: line.replace(/^(?:LaTeX|Package .+|Class .+) Warning:\s*/, '').trim(),
      }
      continue
    }
    const overflow = overfull.exec(line)
    if (overflow !== null) {
      const lineNumber = Number(overflow.groups?.line ?? overflow.groups?.line2 ?? 0)
      push(warnings, {
        file: context.mainFileRel,
        line: Number.isFinite(lineNumber) ? lineNumber : 0,
        message: line.trim(),
      })
    }
  }
  if (pendingWarning !== null) push(warnings, pendingWarning)
  return { errors, warnings, pages }
}

/** 把日志里出现的路径统一成项目内的相对路径（POSIX 分隔符）。 */
export function normalizeRelative(root, file) {
  if (typeof file !== 'string' || file === '') return ''
  let value = file.replace(/\\/g, '/')
  const rootPosix = root.replace(/\\/g, '/').replace(/\/$/, '')
  if (value.startsWith(rootPosix + '/')) value = value.slice(rootPosix.length + 1)
  value = value.replace(/^\.\//, '')
  return value
}

/** 把日志尾部裁到 UI 友好的长度。 */
export function tailOf(text, limit = LOG_TAIL) {
  if (typeof text !== 'string') return ''
  return text.length <= limit ? text : text.slice(text.length - limit)
}

/** 确保目录存在。 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

/**
 * 编译结束后收集产物信息（PDF 大小、synctex 是否存在、页数）。
 * @param {{pdfPath:string,synctexPath:string}} paths
 */
export async function statArtifacts({ pdfPath, synctexPath }) {
  let pdfSize = null
  let rev = null
  try {
    const info = await stat(pdfPath)
    pdfSize = info.size
    rev = `${info.mtimeMs}:${info.size}`
  } catch {
    return { pdfSize: null, rev: null, synctex: false }
  }
  return { pdfSize, rev, synctex: existsSync(synctexPath) }
}

/**
 * 读 .log 文件（如果存在），用于补充错误/警告/页数。
 * @param {string} logPath
 * @returns {Promise<string>} 文本（不存在时为空串）
 */
export async function readLogFile(logPath) {
  try {
    return decodeOutput(await readFile(logPath))
  } catch {
    return ''
  }
}
