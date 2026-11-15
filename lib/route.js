/**
 * HTTP 路由：/dsh-latex/{api,pdf,vendor}。
 *
 * 方法：api 用一个 prefix 路由做 JSON 方法分发（信封 {ok,value}|{ok:false,error}），
 *      pdf 直接流式返回当前编译产物，vendor 只放行 pdf.js 的构建产物与资源。
 * 对象：浏览器端 LaTeX 标签页与任何本机客户端（全部经 connection 准入检查）。
 */
import { createReadStream, existsSync, readdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { ProjectError } from './project.js'

const requireFromHere = createRequire(import.meta.url)
/** 请求体上限。 */
const BODY_LIMIT = 64 * 1024
/** 审阅链路诊断日志（重载插件后可查）。 */
const REVIEW_LOG = join(homedir(), '.dsh', 'better-latex-review.log')
/** pdf.js 已解析的缓存。 */
let pdfjsResolved = false
let pdfjsCache = null

/** 追加一行诊断日志（失败静默）。 */
function logReview(message) {
  try {
    appendFileSync(REVIEW_LOG, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // 日志不可写不影响功能
  }
}

/**
 * 列出所有可能装 pdfjs-dist 的路径。
 * link: 安装的插件按其"真实路径"做 Node 解析，看不到 profile 的 node_modules，
 * 所以要显式候选：profile 目录、DSH_PROFILE_DIR、进程 cwd。
 * @returns {string[]} 候选的 build/pdf.mjs 绝对路径
 */
function pdfjsCandidates() {
  const candidates = []
  for (const name of ['build/pdf.mjs', 'legacy/build/pdf.mjs']) {
    try {
      candidates.push(requireFromHere.resolve(`pdfjs-dist/${name}`))
    } catch {
      // 继续候选
    }
    candidates.push(join(process.cwd(), 'node_modules', 'pdfjs-dist', ...name.split('/')))
  }
  const profilesDir = join(homedir(), '.dsh', 'profiles')
  try {
    for (const name of readdirSync(profilesDir)) {
      for (const rel of ['build/pdf.mjs', 'legacy/build/pdf.mjs']) {
        candidates.push(join(profilesDir, name, 'node_modules', 'pdfjs-dist', ...rel.split('/')))
      }
    }
  } catch {
    // 没有 profiles 目录
  }
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir !== '') {
    for (const rel of ['build/pdf.mjs', 'legacy/build/pdf.mjs']) {
      candidates.push(join(profileDir, 'node_modules', 'pdfjs-dist', ...rel.split('/')))
    }
  }
  return candidates
}

/**
 * 解析 pdfjs-dist 的位置；未安装时返回 null（客户端降级 iframe）。
 * @returns {{pdf:string,worker:string,packageDir:string}|null}
 */
export function resolvePdfjs() {
  if (pdfjsResolved) return pdfjsCache
  pdfjsResolved = true
  for (const candidate of pdfjsCandidates()) {
    if (!existsSync(candidate)) continue
    const buildDir = dirname(candidate)
    const isLegacy = candidate.includes(`${sep}legacy${sep}`)
    const root = isLegacy ? dirname(dirname(dirname(candidate))) : dirname(dirname(candidate))
    const worker = join(buildDir, 'pdf.worker.mjs')
    pdfjsCache = { pdf: candidate, worker: existsSync(worker) ? worker : null, packageDir: root, buildDir }
    logReview(`pdfjs: resolved ${candidate}`)
    return pdfjsCache
  }
  logReview('pdfjs: not found in any candidate')
  pdfjsCache = null
  return null
}

/** pdf.js 资源白名单（相对 pdfjs-dist 包根）。 */
const VENDOR_ALLOW = [
  /^pdf\.mjs$/,
  /^pdf\.worker\.mjs$/,
  /^cmaps\/[A-Za-z0-9._-]+\.bcmap$/,
  /^standard_fonts\/[A-Za-z0-9._-]+\.(?:pfb|ttf|otf)$/,
]

/** 写 JSON 响应（已提交则断开连接）。 */
function writeJson(res, status, body) {
  if (res.headersSent === true) {
    res.destroy?.()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 成功信封。 */
function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

/** 失败信封（ProjectError 自带错误码与状态）。 */
function writeError(res, error) {
  if (error instanceof ProjectError) {
    const status = error.code === 'no-main-file' || error.code === 'no-toolchain' || error.code === 'no-pdf' || error.code === 'no-synctex' ? 409 : error.code === 'bad-request' ? 400 : 500
    writeJson(res, status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}

/** 读 JSON 请求体（带上限）。 */
function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        rejectPromise(new ProjectError('too-large', '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolvePromise({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolvePromise(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        rejectPromise(new ProjectError('bad-request', '请求体不是合法 JSON'))
      }
    })
    req.on('error', (error) => rejectPromise(error))
  })
}

/**
 * 创建路由处理器。
 * @param {{ctx:object,store:object}} input
 * @returns {{api:Function,pdf:Function,vendor:Function}}
 */
export function createRoute({ ctx, store }) {
  const pdfjs = resolvePdfjs()

  const fenced = (req) => {
    try {
      const connection = ctx.get('connection')
      if (connection === undefined || typeof connection.requestRejection !== 'function') return true
      return connection.requestRejection(req) === undefined
    } catch {
      return true
    }
  }

  const cwdOf = async (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') throw new ProjectError('bad-request', '缺少 sessionId')
    const sessions = ctx.get('sessions')
    const session = sessions?.get?.(sessionId)
    const workingDirectory = ctx.get('workingDirectory')
    const cwd = session === undefined ? undefined : workingDirectory?.get?.(session) ?? session.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
    throw new ProjectError('bad-request', `无法解析会话 ${sessionId} 的工作目录`)
  }

  const projectOf = async (payload) => {
    const cwd = await cwdOf(payload.sessionId)
    const project = await store.ensure(cwd)
    return project
  }

  const methods = {
    async project(payload) {
      const project = await projectOf(payload)
      const status = await store.statusOf(project, { pdfjs: pdfjs !== null })
      // 打开标签页时若尚未编译过，先安静地编译一次（失败不抛出，交给状态展示）。
      if (!project.hasCompiled && project.mainFileRel !== null && project.toolchain !== null) {
        try {
          await store.compile(project, { reason: 'open' })
        } catch {
          // 状态里已记录错误
        }
      }
      return { ...(await store.statusOf(project, { pdfjs: pdfjs !== null, previous: status.rev })) }
    },
    async status(payload) {
      const project = await projectOf(payload)
      return store.statusOf(project, { pdfjs: pdfjs !== null })
    },
    async compile(payload) {
      const project = await projectOf(payload)
      if (typeof payload.mainFile === 'string' && payload.mainFile !== '') await store.setMainFile(project, payload.mainFile)
      if (typeof payload.engine === 'string') await store.updateSettings(project, { engine: payload.engine })
      const result = await store.compile(project, { reason: 'client', clean: payload.clean === true })
      return { ...result, status: await store.statusOf(project, { pdfjs: pdfjs !== null }) }
    },
    async cancel(payload) {
      const project = await projectOf(payload)
      store.cancel(project)
      return { ok: true }
    },
    async settings(payload) {
      const project = await projectOf(payload)
      if (payload.settings !== null && typeof payload.settings === 'object') {
        await store.updateSettings(project, payload.settings)
      }
      return { settings: await store.updateSettings(project, {}), status: await store.statusOf(project, { pdfjs: pdfjs !== null }) }
    },
    async mainFile(payload) {
      const project = await projectOf(payload)
      await store.setMainFile(project, String(payload.mainFile ?? ''))
      return { status: await store.statusOf(project, { pdfjs: pdfjs !== null }) }
    },
    async source(payload) {
      const project = await projectOf(payload)
      return store.readSource(project, typeof payload.path === 'string' ? payload.path : undefined, Number(payload.maxLines) || 2000)
    },
    /** 手动编辑某一行源码（原子写 + mtime CAS），基线不动，改动进入「改动」页签。 */
    async 'write.source'(payload) {
      const project = await projectOf(payload)
      const path = typeof payload.path === 'string' && payload.path !== '' ? payload.path : undefined
      const result = await store.writeLine(
        project,
        path,
        Number(payload.line) || 0,
        String(payload.text ?? ''),
        Number.isFinite(payload.expectedMtimeMs) ? Number(payload.expectedMtimeMs) : undefined,
      )
      return { ...result, status: await store.statusOf(project, { pdfjs: pdfjs !== null }) }
    },
    async 'sync.view'(payload) {
      const project = await projectOf(payload)
      return store.syncView(project, {
        file: typeof payload.file === 'string' ? payload.file : undefined,
        line: Number(payload.line) || 1,
        column: Number(payload.column) || 1,
      })
    },
    async 'sync.edit'(payload) {
      const project = await projectOf(payload)
      return store.syncEdit(project, {
        page: Number(payload.page) || 1,
        x: Number(payload.x) || 0,
        y: Number(payload.y) || 0,
      })
    },
    /** 拖框批注：矩形 → 源码行区间。x/y/w/h 单位 PDF 点。 */
    async 'sync.range'(payload) {
      const project = await projectOf(payload)
      return store.syncRange(project, {
        page: Number(payload.page) || 1,
        x: Number(payload.x) || 0,
        y: Number(payload.y) || 0,
        w: Math.max(1, Number(payload.w) || 0),
        h: Math.max(1, Number(payload.h) || 0),
      })
    },
    async changes(payload) {
      const project = await projectOf(payload)
      return store.changesOf(project)
    },
    async diff(payload) {
      const project = await projectOf(payload)
      const path = typeof payload.path === 'string' ? payload.path : ''
      if (path === '') throw new ProjectError('bad-request', '缺少 path')
      const result = await project.review.diff(path)
      if (result === null) throw new ProjectError('bad-request', `未知文件: ${path}`)
      return result
    },
    async accept(payload) {
      const project = await projectOf(payload)
      const paths = Array.isArray(payload.paths) ? payload.paths.filter((entry) => typeof entry === 'string') : []
      if (paths.length === 0) throw new ProjectError('bad-request', '缺少 paths')
      const result = await store.acceptFiles(project, paths)
      return { ...result, changes: await store.changesOf(project) }
    },
    async reject(payload) {
      const project = await projectOf(payload)
      const paths = Array.isArray(payload.paths) ? payload.paths.filter((entry) => typeof entry === 'string') : []
      if (paths.length === 0) throw new ProjectError('bad-request', '缺少 paths')
      const expected = Number.isFinite(payload.expectedMtimeMs) ? Number(payload.expectedMtimeMs) : undefined
      const result = await store.rejectFiles(project, paths, expected)
      if (result.rejected.length > 0 && project.settings.autoCompile) {
        try {
          await store.compile(project, { reason: 'reject' })
        } catch {
          // 编译错误进状态
        }
      }
      return { ...result, changes: await store.changesOf(project) }
    },
    /** Papilot 式审阅：改动 + 排版锚点 + 基线 PDF 状态。 */
    async review(payload) {
      const project = await projectOf(payload)
      const path = typeof payload.path === 'string' && payload.path !== ''
        ? payload.path
        : (await store.changesOf(project)).files[0]?.path
      if (path === undefined) {
        logReview(`review: no changed path (compare=${project.compare.state})`)
        return { path: null, changes: [], compare: { state: project.compare.state } }
      }
      const value = await store.reviewOf(project, path, { ensure: payload.ensure !== false })
      logReview(
        `review: path=${path} compare=${value.compare.state}/${value.compare.rev ?? '-'} changes=${value.changes.length} `
        + `anchors=${value.changes.filter((change) => change.after !== null).length}after/${value.changes.filter((change) => change.before !== null).length}before`,
      )
      return value
    },
    /** 构建/复用基线 PDF。 */
    async compare(payload) {
      const project = await projectOf(payload)
      const state = await store.ensureCompare(project)
      logReview(`compare: state=${state.state} rev=${state.rev ?? '-'} ${state.message ?? ''}`)
      return { state: state.state, rev: state.rev, message: state.message }
    },
    /** 逐 hunk 决策。 */
    async decide(payload) {
      const project = await projectOf(payload)
      const path = typeof payload.path === 'string' ? payload.path : ''
      if (path === '') throw new ProjectError('bad-request', '缺少 path')
      const accept = Array.isArray(payload.accept) ? payload.accept.filter((index) => Number.isInteger(index)) : []
      const reject = Array.isArray(payload.reject) ? payload.reject.filter((index) => Number.isInteger(index)) : []
      if (accept.length === 0 && reject.length === 0) throw new ProjectError('bad-request', '缺少 accept/reject')
      const expected = Number.isFinite(payload.expectedMtimeMs) ? Number(payload.expectedMtimeMs) : undefined
      if (expected !== undefined) {
        const { stat } = await import('node:fs/promises')
        const info = await stat(resolve(project.root, path.split('/').join(sep))).catch(() => null)
        if (info !== null && Math.abs(info.mtimeMs - expected) > 2) {
          throw new ProjectError('conflict', '文件在此期间被改动，请刷新差异后重试')
        }
      }
      const result = await store.decide(project, path, { accept, reject })
      return { ...result, review: await store.reviewOf(project, path, { ensure: false }) }
    },
    /** 撤销上一次决策。 */
    async undo(payload) {
      const project = await projectOf(payload)
      const result = await store.undo(project)
      return { ...result, changes: await store.changesOf(project) }
    },
    /** 批注读取/保存。 */
    async 'notes.list'(payload) {
      const project = await projectOf(payload)
      return store.readNotes(project)
    },
    async 'notes.save'(payload) {
      const project = await projectOf(payload)
      return store.writeNotes(project, payload.notes)
    },
    async 'notes.clear'(payload) {
      const project = await projectOf(payload)
      return store.writeNotes(project, [])
    },
  }

  const api = async (req, res) => {
    if (!fenced(req)) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const prefix = '/dsh-latex/api/'
    const method = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : ''
    if (method === '' || method.includes('/')) {
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown api method' } })
      return
    }
    const handler = Object.hasOwn(methods, method) ? methods[method] : undefined
    if (typeof handler !== 'function') {
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown api method "${method}"` } })
      return
    }
    try {
      const payload = await readJsonBody(req)
      writeOk(res, await handler(payload))
    } catch (error) {
      writeError(res, error)
    }
  }

  const pdf = async (req, res) => {
    if (!fenced(req)) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const sessionId = url.searchParams.get('sessionId')
      const which = url.searchParams.get('which') === 'baseline' ? 'baseline' : 'current'
      const project = await projectOf({ sessionId })
      if (which === 'baseline' && (project.compare === undefined || project.compare.state !== 'ready')) {
        logReview(`pdf: baseline requested while compare=${project.compare?.state ?? 'none'}`)
        void store.ensureCompare(project)
        throw new ProjectError('compare-building', '基线 PDF 正在构建，请稍后重试')
      }
      const file = which === 'baseline' ? store.baselinePdf(project) : project.pdfAbs
      if (file === null || !existsSync(file)) throw new ProjectError('no-pdf', '还没有编译产物')
      const info = await stat(file)
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': String(info.size),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(file).pipe(res)
    } catch (error) {
      writeError(res, error)
    }
  }

  const vendor = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
      return
    }
    if (pdfjs === null) {
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'pdfjs-dist is not installed' } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const relative = url.pathname.replace(/^\/dsh-latex\/vendor\//, '')
    if (!VENDOR_ALLOW.some((pattern) => pattern.test(relative))) {
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'not a vendor asset' } })
      return
    }
    // pdf.mjs / pdf.worker.mjs 实际在包的 build/（或 legacy/build/）下，不是包根。
    let file
    if (relative === 'pdf.mjs') file = pdfjs.pdf
    else if (relative === 'pdf.worker.mjs') file = pdfjs.worker
    else file = resolve(pdfjs.packageDir, relative.split('/').join(sep))
    if (file === null || file === undefined || !existsSync(file)) {
      logReview(`vendor missing: ${relative} (pkg=${pdfjs.packageDir})`)
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'missing vendor asset' } })
      return
    }
    const contentType = relative.endsWith('.mjs') || relative.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : relative.startsWith('cmaps/')
        ? 'application/octet-stream'
        : relative.endsWith('.ttf')
          ? 'font/ttf'
          : relative.endsWith('.otf')
            ? 'font/otf'
            : 'application/x-font-type1'
    const info = await stat(file)
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': String(info.size),
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(file).pipe(res)
  }

  return { api, pdf, vendor }
}
