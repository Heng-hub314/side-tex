/**
 * 源文件列举与读取：变更审阅和主文件探测共用。
 *
 * 方法：递归遍历项目根，跳过构建目录、隐藏目录与 node_modules，按扩展名与大小过滤。
 * 对象：一个 LaTeX 项目的可审阅源文件集合。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 审阅时永远跳过的目录名。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.dsh-latex'])

/**
 * 把用户给的相对路径安全地解析到项目根内。
 * @param {string} root - 项目根（绝对）
 * @param {string} relPath - 相对路径
 * @returns {string|null} 绝对路径；越界返回 null
 */
export function safeResolve(root, relPath) {
  if (typeof relPath !== 'string' || relPath === '') return null
  const abs = isAbsolute(relPath) ? resolve(relPath) : resolve(root, relPath)
  const rel = relative(root, abs)
  if (rel === '') return abs
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}

/**
 * 列出项目里的源文件。
 * @param {string} root - 项目根
 * @param {{trackExts?:string[],maxFiles?:number,maxDepth?:number,maxBytes?:number}} [options]
 * @returns {Promise<Array<{rel:string,abs:string,size:number,mtimeMs:number}>>}
 */
export async function listSourceFiles(root, options = {}) {
  const exts = new Set((options.trackExts ?? ['.tex']).map((ext) => ext.toLowerCase()))
  const maxFiles = options.maxFiles ?? 400
  const maxDepth = options.maxDepth ?? 6
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024
  const out = []
  const walk = async (dir, depth) => {
    if (out.length >= maxFiles || depth > maxDepth) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      const name = entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
        await walk(join(dir, name), depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const dot = name.lastIndexOf('.')
      if (dot <= 0) continue
      if (!exts.has(name.slice(dot).toLowerCase())) continue
      const abs = join(dir, name)
      let info
      try {
        info = await stat(abs)
      } catch {
        continue
      }
      if (info.size > maxBytes) continue
      out.push({ rel: relative(root, abs).split(sep).join('/'), abs, size: info.size, mtimeMs: info.mtimeMs })
    }
  }
  await walk(root, 0)
  out.sort((a, b) => a.rel.localeCompare(b.rel))
  return out
}

/**
 * 读一个文本文件（超过上限时截断）。
 * @param {string} abs - 绝对路径
 * @param {number} [maxBytes] - 上限
 * @returns {Promise<{text:string,truncated:boolean}>}
 */
export async function readTextFile(abs, maxBytes = 2 * 1024 * 1024) {
  const buffer = await readFile(abs)
  const truncated = buffer.length > maxBytes
  const slice = truncated ? buffer.subarray(0, maxBytes) : buffer
  return { text: slice.toString('utf8'), truncated }
}

/**
 * 把绝对路径改写成项目内相对路径（POSIX 分隔符）。
 * @param {string} root
 * @param {string} abs
 * @returns {string}
 */
export function relativeTo(root, abs) {
  return relative(root, abs).split(sep).join('/')
}
