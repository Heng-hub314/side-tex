/**
 * 基线排版构建：把"已接受"的源文件在一个镜像目录里重新编译成 baseline PDF。
 *
 * 方法：复制项目树到 .dsh-latex/compare/<key>/src（排除 .dsh-latex/.git/node_modules/隐藏目录），
 *      用基线副本覆盖被追踪源文件，再在镜像里跑 latexmk（outdir=.build）。
 *      key = 被追踪文件的 rel+sha + 引擎 + 主文件，命中即复用缓存。
 * 对象：一个项目"已接受版本"的排版结果，用于 Papilot 式的 before/after 对比。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { compileArgv, ensureDir, readLogFile, runCompile, tailOf } from './compile.js'
import { listSourceFiles } from './source-files.js'

/** 镜像复制的文件数上限。 */
const MAX_FILES = 3000
/** 镜像复制的总大小上限（字节）。 */
const MAX_BYTES = 200 * 1024 * 1024

/** 镜像必须放在项目根之外（fs.cp 不允许复制到自身子目录）。 */
function mirrorBase(projectRoot) {
  const hash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 12)
  return join(tmpdir(), 'dsh-side-tex-compare', hash)
}

/** 带错误码的对比构建错误。 */
export class CompareError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'CompareError'
    this.code = code
  }
}

/** 不该进入镜像的目录（相对项目根的 POSIX 片段）。 */
function skipped(relativePath) {
  const parts = relativePath.split('/')
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '.dsh-latex' || part === '.git' || part === 'node_modules') return true
    if (part.startsWith('.')) return true
  }
  return false
}

/**
 * 计算基线构建缓存 key。
 * @param {{project:object}} input
 * @returns {Promise<string>}
 */
async function compareKey(project) {
  const files = await listSourceFiles(project.root, {
    trackExts: project.settings.trackExts,
    maxFiles: 400,
    maxBytes: project.settings.maxReviewBytes,
  })
  const parts = [project.settings.engine, project.mainFileRel ?? '']
  for (const file of files) {
    const entry = project.baseline.entry(file.rel)
    parts.push(`${file.rel}:${entry?.sha256 ?? 'missing'}`)
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

/**
 * 构建（或复用）基线 PDF。
 * @param {{project:object}} input
 * @returns {Promise<{key:string,dir:string,src:string,pdfAbs:string,synctexAbs:string,rev:string}>}
 */
export async function buildBaseline({ project }) {
  const key = await compareKey(project)
  const base = mirrorBase(project.root)
  const dir = join(base, key.slice(0, 12))
  const src = join(dir, 'src')
  const build = join(src, '.build')
  const stem = project.mainFileRel === null ? null : basename(project.mainFileRel).replace(/\.tex$/i, '')
  if (stem === null) throw new CompareError('no-main-file', '未找到主文件')
  const pdfAbs = join(build, `${stem}.pdf`)
  const synctexAbs = join(build, `${stem}.pdf.synctex.gz`)
  const keyFile = join(dir, 'key.txt')
  try {
    const cachedKey = (await readFile(keyFile, 'utf8')).trim()
    if (cachedKey === key && existsSync(pdfAbs)) {
      const info = await stat(pdfAbs)
      return { key, dir, src, compileCwd, pdfAbs, synctexAbs, rev: `${info.mtimeMs}:${info.size}` }
    }
  } catch {
    // 没有缓存
  }
  const toolchain = project.toolchain
  if (toolchain === null || toolchain === undefined) throw new CompareError('no-toolchain', '未找到 TeX 工具链')

  await rm(dir, { recursive: true, force: true })
  await mkdir(src, { recursive: true })
  let files = 0
  let bytes = 0
  try {
    await cp(project.root, src, {
      recursive: true,
      filter: async (source) => {
        const relative = source.slice(project.root.length).split(sep).join('/').replace(/^\//, '')
        if (skipped(relative)) return false
        try {
          const info = await stat(source)
          if (info.isFile()) {
            files += 1
            bytes += info.size
            if (files > MAX_FILES) throw new CompareError('compare-too-large', `项目文件超过 ${MAX_FILES} 个，已跳过 before/after 构建`)
            if (bytes > MAX_BYTES) throw new CompareError('compare-too-large', '项目体积超过 200MB，已跳过 before/after 构建')
          }
        } catch (error) {
          if (error instanceof CompareError) throw error
        }
        return true
      },
    })
  } catch (error) {
    if (error instanceof CompareError) throw error
    throw new CompareError('compare-copy-failed', `复制项目到对比目录失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // 用基线副本覆盖被追踪的源文件
  for (const rel of project.baseline.list()) {
    const text = await project.baseline.readText(rel)
    if (text === null) continue
    const target = resolve(src, rel.split('/').join(sep))
    if (!target.startsWith(src + sep)) continue
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, text, 'utf8')
  }

  await ensureDir(build)
  const settings = { ...project.settings, buildDir: '.build' }
  // 与主编译一致：在主文件目录里跑，产物目录给绝对路径。
  const compileCwd = join(src, dirname(project.mainFileRel))
  const argv = compileArgv({
    toolchain,
    settings,
    mainFileRel: project.mainFileRel,
    cwd: compileCwd,
    outDirAbs: build,
  })
  const result = await runCompile({ argv, cwd: compileCwd, timeoutMs: project.settings.compileTimeoutMs })
  if (result.code !== 0) {
    const logPath = join(build, `${stem}.log`)
    const log = tailOf(await readLogFile(logPath), 1200)
    throw new CompareError('compare-build-failed', `基线编译失败（退出码 ${result.code ?? '未知'}）${log === '' ? '' : `\n${log}`}`)
  }
  if (!existsSync(pdfAbs)) throw new CompareError('compare-build-failed', '基线编译没有产出 PDF')
  const info = await stat(pdfAbs)
  await writeFile(keyFile, key, 'utf8')
  await pruneMirrors(base, key.slice(0, 12), 3)
  return { key, dir, src, compileCwd, pdfAbs, synctexAbs, rev: `${info.mtimeMs}:${info.size}` }
}

/**
 * 只保留最近使用的几个镜像目录。
 * @param {string} base
 * @param {string} keepName
 * @param {number} keep
 */
async function pruneMirrors(base, keepName, keep = 3) {
  try {
    const entries = await readdir(base, { withFileTypes: true })
    const dirs = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(base, entry.name)
      try {
        const info = await stat(dir)
        dirs.push({ dir, name: entry.name, at: info.mtimeMs })
      } catch {
        // 忽略
      }
    }
    dirs.sort((a, b) => (a.name === keepName ? -1 : b.name === keepName ? 1 : b.at - a.at))
    for (const stale of dirs.slice(keep)) await rm(stale.dir, { recursive: true, force: true })
  } catch {
    // 没有缓存目录
  }
}
