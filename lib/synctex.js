/**
 * SyncTeX 双向定位：正向（源码行 → PDF 页/坐标）与反向（PDF 页/坐标 → 源码行）。
 *
 * 方法：调用 TeX Live 自带的 synctex CLI（`view -i line:column:file -o pdf` /
 *      `edit -o page:x:y:pdf`），以 Buffer 收集输出后按"UTF-8 严格 → GBK → latin1"
 *      解码（Windows 上 Input: 路径按 ANSI 代码页写出），再解析成结构化记录。
 * 对象：一个项目的主文件与编译产物 PDF；所有返回路径都归一化成项目内相对路径。
 *
 * 坐标约定（已用 TeX Live 2024 + letter 文档标定）：synctex 的 x/y 以 PDF 点
 * （1/72 英寸）为单位、原点在页面左上角；与 pdf.js viewport(scale=1) 同尺度。
 */
import { spawn, spawnSync } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { decodeOutput, normalizeRelative } from './compile.js'

/** 单次 synctex 调用的超时。 */
const TIMEOUT_MS = 8000

/** 矩形 → 行区间的采样参数（PDF 点；A4 正文行高约 12pt，9pt 步长可覆盖每一行）。 */
const ROW_STEP_PT = 9
const MAX_ROWS = 12
const MAX_SAMPLES = 24
const SAMPLE_CONCURRENCY = 6
/** 一条批注最多覆盖的行数。 */
const MAX_RANGE_LINES = 120
/** 判断 box 与矩形是否相交的容差。 */
const RANGE_TOL_PT = 1
/** 外扩时要求「这一行至少被矩形盖住这么多」，避免把紧贴下边界的下一行也算进来。 */
const RANGE_COVER_RATIO = 0.34
/** 一次区间解析最多做多少次正向搜索（边界收紧/外扩）。 */
const RANGE_FORWARD_BUDGET = 40

/**
 * 跑一次 synctex 并把结果按行返回。
 * @param {string} bin - synctex 可执行文件
 * @param {string[]} args - 参数
 * @param {string} cwd - 工作目录
 * @returns {string[]} 输出行（已解码）
 */
function runSynctex(bin, args, cwd) {
  const result = spawnSync(bin, args, {
    cwd,
    timeout: TIMEOUT_MS,
    windowsHide: true,
    encoding: 'buffer',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error !== undefined && result.error !== null) return []
  const text = decodeOutput(result.stdout ?? Buffer.alloc(0))
  return text.split(/\r\n|\n|\r/)
}

/**
 * 异步跑一次 synctex（区间解析要并发采样，spawnSync 会串行阻塞事件循环）。
 * @returns {Promise<string>} 已解码输出
 */
function runSynctexAsync(bin, args, cwd, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolveText) => {
    let settled = false
    let timer = null
    const finish = (text) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolveText(text)
    }
    let child
    try {
      child = spawn(bin, args, { cwd, windowsHide: true })
    } catch {
      finish('')
      return
    }
    const chunks = []
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 已退出
      }
      finish(decodeOutput(Buffer.concat(chunks)))
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => chunks.push(chunk))
    child.stderr?.on('data', () => {})
    child.on('error', () => finish(''))
    child.on('close', () => finish(decodeOutput(Buffer.concat(chunks))))
  })
}

/** 并发跑一组异步任务（保持结果顺序）。 */
async function runPool(tasks, limit) {
  const results = new Array(tasks.length)
  let next = 0
  const workers = []
  for (let index = 0; index < Math.min(limit, tasks.length); index += 1) {
    workers.push((async () => {
      for (;;) {
        const current = next
        next += 1
        if (current >= tasks.length) return
        results[current] = await tasks[current]()
      }
    })())
  }
  await Promise.all(workers)
  return results
}

/**
 * 解析 `synctex edit` 的输出，得到项目内的候选记录。
 * 同一个点可能给出多条（多行/多文件），全部保留。
 */
function parseEditRecords(text, base, root) {
  const candidates = []
  let current = null
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.trim()
    if (line.startsWith('Input:')) {
      current = { file: line.slice(6) }
    } else if (current !== null && line.startsWith('Line:')) {
      current.line = Number(line.slice(5))
    } else if (current !== null && line.startsWith('Column:')) {
      current.column = Number(line.slice(7))
      if (typeof current.file === 'string' && Number.isFinite(current.line)) {
        const absolute = resolveSynctexPath(base, current.file)
        if (absolute !== null) {
          const relative = normalizeRelative(root, absolute)
          if (relative !== '' && !relative.startsWith('..')) {
            candidates.push({
              file: relative,
              absolute,
              line: current.line,
              column: Number.isFinite(current.column) ? current.column : 0,
            })
          }
        }
      }
      current = null
    }
  }
  return candidates
}

/**
 * 正向搜索：源码位置 → PDF 页与矩形。
 * @param {{bin:string,root:string,texFile:string,pdfFile:string,line:number,column?:number,baseDir?:string}} input
 *        baseDir：编译时的 cwd（主文件目录）；相对路径按它解析，最后仍按 root 归一化。
 * @returns {Promise<{ok:boolean,page:number,x:number,y:number,width:number,height:number}|null>}
 */
export async function forwardSearch({ bin, root, texFile, pdfFile, line, column = 1, baseDir }) {
  if (bin === null || bin === undefined) return null
  const base = typeof baseDir === 'string' && baseDir !== '' ? baseDir : root
  const tex = isAbsolute(texFile) ? texFile : resolve(base, texFile)
  const pdf = isAbsolute(pdfFile) ? pdfFile : resolve(base, pdfFile)
  const lines = runSynctex(bin, ['view', '-i', `${Math.max(1, line)}:${Math.max(1, column)}:${tex}`, '-o', pdf], root)
  const records = []
  let current = null
  for (const raw of lines) {
    const text = raw.trim()
    if (text.startsWith('Page:')) {
      current = { page: Number(text.slice(5)) }
    } else if (current !== null && text.startsWith('x:')) {
      current.x = Number(text.slice(2))
    } else if (current !== null && text.startsWith('y:')) {
      current.y = Number(text.slice(2))
    } else if (current !== null && text.startsWith('W:')) {
      current.width = Number(text.slice(2))
    } else if (current !== null && text.startsWith('H:')) {
      current.height = Number(text.slice(2))
      if (Number.isFinite(current.page)) records.push(current)
      current = null
    }
  }
  const first = records.find((record) => record.page > 0 && Number.isFinite(record.x) && Number.isFinite(record.y))
  if (first === undefined) return null
  return {
    ok: true,
    page: first.page,
    x: first.x,
    y: first.y,
    width: Number.isFinite(first.width) ? first.width : 0,
    height: Number.isFinite(first.height) ? first.height : 10,
  }
}

/**
 * 反向搜索：PDF 页与坐标 → 源码文件/行。
 * synctex 会返回多条候选（同一位置可能落在多行/多文件），这里保留项目内的记录。
 * @param {{bin:string,root:string,pdfFile:string,page:number,x:number,y:number,baseDir?:string}} input
 *        baseDir：编译时的 cwd（主文件目录）。SyncTeX 的 Input: 常是相对该目录的路径，
 *        解析后再按 root 归一化成项目内相对路径。
 * @returns {Promise<{ok:boolean,file:string,absolute:string,line:number,column:number,
 *                    candidates:Array<{file:string,line:number}>}|null>}
 */
export async function inverseSearch({ bin, root, pdfFile, page, x, y, baseDir }) {
  if (bin === null || bin === undefined) return null
  const base = typeof baseDir === 'string' && baseDir !== '' ? baseDir : root
  const pdf = isAbsolute(pdfFile) ? pdfFile : resolve(base, pdfFile)
  const lines = runSynctex(
    bin,
    ['edit', '-o', `${Math.max(1, page)}:${Math.max(0, x).toFixed(2)}:${Math.max(0, y).toFixed(2)}:${pdf}`],
    base,
  )
  const candidates = parseEditRecords(lines.join('\n'), base, root)
  if (candidates.length === 0) return null
  const first = candidates[0]
  return {
    ok: true,
    file: first.file,
    absolute: first.absolute,
    line: first.line,
    column: first.column,
    candidates: candidates.slice(0, 8).map((entry) => ({ file: entry.file, line: entry.line })),
  }
}

/**
 * 把 synctex 的 Input 路径解析成绝对路径：兼容正/反斜杠、`./`、以及相对项目根的形式。
 * @param {string} root - 项目根
 * @param {string} raw - synctex 输出
 * @returns {string|null} 绝对路径（不在项目内时仍返回，由调用方判断）
 */
export function resolveSynctexPath(root, raw) {
  if (typeof raw !== 'string' || raw === '') return null
  let value = raw.trim().replace(/\\/g, '/')
  const drive = /^[a-zA-Z]:\//.test(value)
  const unc = value.startsWith('//')
  if (drive || unc) return resolve(value)
  value = value.replace(/^\.\//, '')
  return resolve(root, value)
}

/**
 * 健康检查：synctex 是否可用（返回版本首行）。
 * @param {string|null} bin
 * @param {string} cwd
 * @returns {string|null}
 */
export function synctexVersion(bin, cwd) {
  if (bin === null || bin === undefined) return null
  const lines = runSynctex(bin, ['--version'], cwd)
  const first = lines.find((line) => line.trim() !== '')
  return first === undefined ? null : first.trim()
}

/** 正向搜索得到某一行的排版框（PDF 点，页面左上原点；y 是该行基线）。 */
function boxOf(bin, root, base, pdf, file, line) {
  return forwardSearch({
    bin,
    root,
    baseDir: base,
    texFile: resolve(root, file),
    pdfFile: pdf,
    line,
    column: 1,
  })
}

/** 行框与矩形在纵向上的覆盖比例（0 表示不相交；同页才有意义）。 */
function boxOverlap(box, page, rect) {
  if (box === null || box === undefined || box.ok !== true || box.page !== page) return 0
  const height = Math.max(box.height || 0, 1)
  const width = Math.max(box.width || 0, 1)
  const xOverlap = Math.min(box.x + width, rect.x + rect.w) - Math.max(box.x, rect.x)
  if (xOverlap <= -RANGE_TOL_PT) return 0
  const top = box.y - height
  const bottom = box.y
  const yOverlap = Math.min(bottom, rect.y + rect.h) - Math.max(top, rect.y)
  return Math.max(0, yOverlap) / height
}

/** 有一点纵向重叠就算命中（用于向内收紧）。 */
function intersectsRect(box, page, rect) {
  return boxOverlap(box, page, rect) > 0
}

/** 被矩形盖住足够多才算这一行属于选区（用于向外扩展）。 */
function coversLine(box, page, rect) {
  return boxOverlap(box, page, rect) >= RANGE_COVER_RATIO
}

/** 两个 box 是否指向同一处排版（同一行源码没有独立排版时，synctex 会回落到上一行）。 */
function sameBox(left, right) {
  if (left === null || right === null) return false
  if (left.ok !== true || right.ok !== true) return false
  return left.page === right.page
    && Math.abs(left.x - right.x) < 0.5
    && Math.abs(left.y - right.y) < 0.5
}

/**
 * 用正向搜索把采样的 min/max 收紧/外扩到「真正与矩形相交的整行范围」。
 * 采样点落在行间空隙时会返回最近的一行，所以采样边界通常要比真实范围略大。
 * @param {{left:number}} budget - 共享的正向搜索预算，避免极端矩形把窗口拖住
 */
async function refineGroup({ bin, root, base, pdf, page, rect, group, budget }) {
  let line = Math.max(1, group.line)
  let endLine = Math.max(line, group.endLine)
  const sampled = { line, endLine }
  const canSearch = () => budget.left > 0
  const cache = new Map()
  const boxAt = async (target) => {
    if (cache.has(target)) return cache.get(target)
    budget.left -= 1
    const value = await boxOf(bin, root, base, pdf, group.file, target)
    cache.set(target, value)
    return value
  }

  // 向内收：采样点落在行间空隙时，synctex 给的是最近的一行，可能并不与矩形相交
  for (let step = 0; step < 6 && endLine > line && canSearch(); step += 1) {
    if (intersectsRect(await boxAt(line), page, rect)) break
    line += 1
  }
  for (let step = 0; step < 6 && endLine > line && canSearch(); step += 1) {
    if (intersectsRect(await boxAt(endLine), page, rect)) break
    endLine -= 1
  }
  // 向外扩：只并进「被矩形盖住足够多」的行；空行/注释没有独立排版，
  // synctex 会回落到上一行，此时 box 完全相同，不能再把行号往外推。
  for (let step = 0; step < 24 && line > 1 && canSearch() && endLine - line + 1 < MAX_RANGE_LINES; step += 1) {
    const candidate = await boxAt(line - 1)
    if (!coversLine(candidate, page, rect)) break
    if (sameBox(candidate, await boxAt(line))) break
    line -= 1
  }
  for (let step = 0; step < 24 && canSearch() && endLine - line + 1 < MAX_RANGE_LINES; step += 1) {
    const candidate = await boxAt(endLine + 1)
    if (!coversLine(candidate, page, rect)) break
    if (sameBox(candidate, await boxAt(endLine))) break
    endLine += 1
  }
  if (endLine < line) return { file: group.file, line: sampled.line, endLine: sampled.endLine, hits: group.hits }
  return { file: group.file, line, endLine, hits: group.hits }
}

/**
 * 反向搜索的范围版：PDF 上一块矩形 → 源码行区间（可跨文件分组）。
 *
 * 方法：在矩形内按「3 列 × 每 9pt 一行」采样（≤24 点，并发 6 个 synctex 进程），
 *      按文件分组取 min/max，再用正向搜索把边界收紧到真正与矩形相交的整行。
 * 对象：PDF 拖框批注要锚定的一段源码。
 * @param {{bin:string,root:string,pdfFile:string,baseDir?:string,page:number,
 *          x:number,y:number,w:number,h:number}} input - x/y/w/h 单位 PDF 点
 * @returns {Promise<{ok:boolean,page:number,file:string,line:number,endLine:number,
 *                    groups:Array<{file:string,line:number,endLine:number,hits:number}>}|null>}
 */
export async function inverseSearchRange({ bin, root, pdfFile, page, x, y, w, h, baseDir }) {
  if (bin === null || bin === undefined) return null
  const base = typeof baseDir === 'string' && baseDir !== '' ? baseDir : root
  const pdf = isAbsolute(pdfFile) ? pdfFile : resolve(base, pdfFile)
  const pageNumber = Math.max(1, Math.floor(page) || 1)
  const width = Math.max(1, Number(w) || 0)
  const height = Math.max(1, Number(h) || 0)
  const rect = { x: Math.max(0, Number(x) || 0), y: Math.max(0, Number(y) || 0), w: width, h: height }

  // 采样网格：列固定 3 档（正文/居中公式/图注都能覆盖），行按 9pt 步长
  const columns = width > 24 ? [0.15, 0.5, 0.85] : [0.5]
  const rows = Math.min(MAX_ROWS, Math.max(2, Math.ceil(height / ROW_STEP_PT)))
  const points = []
  const seen = new Set()
  for (let row = 0; row < rows; row += 1) {
    const ratio = (row + 0.5) / rows
    for (const column of columns) {
      const point = { x: rect.x + width * column, y: rect.y + height * ratio }
      const key = `${point.x.toFixed(1)}:${point.y.toFixed(1)}`
      if (seen.has(key)) continue
      seen.add(key)
      points.push(point)
    }
  }
  // 超上限时等距抽稀，保证首尾仍在
  let samples = points
  if (samples.length > MAX_SAMPLES) {
    const stride = samples.length / MAX_SAMPLES
    samples = Array.from({ length: MAX_SAMPLES }, (_, index) => samples[Math.min(samples.length - 1, Math.floor(index * stride))])
  }

  const texts = await runPool(
    samples.map((point) => () => runSynctexAsync(
      bin,
      ['edit', '-o', `${pageNumber}:${point.x.toFixed(2)}:${point.y.toFixed(2)}:${pdf}`],
      base,
    )),
    SAMPLE_CONCURRENCY,
  )

  const groups = new Map()
  for (const text of texts) {
    for (const candidate of parseEditRecords(text, base, root)) {
      const entry = groups.get(candidate.file)
      if (entry === undefined) {
        groups.set(candidate.file, { file: candidate.file, line: candidate.line, endLine: candidate.line, hits: 1 })
      } else {
        entry.hits += 1
        entry.line = Math.min(entry.line, candidate.line)
        entry.endLine = Math.max(entry.endLine, candidate.line)
      }
    }
  }
  if (groups.size === 0) return null

  const budget = { left: RANGE_FORWARD_BUDGET }
  const ranked = [...groups.values()].sort((left, right) => right.hits - left.hits).slice(0, 4)
  const refined = []
  for (const group of ranked) {
    refined.push(await refineGroup({ bin, root, base, pdf, page: pageNumber, rect, group, budget }))
  }
  const primary = refined[0]
  return {
    ok: true,
    page: pageNumber,
    file: primary.file,
    line: primary.line,
    endLine: Math.max(primary.line, primary.endLine),
    groups: refined,
  }
}
