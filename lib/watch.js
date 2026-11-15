/**
 * 项目文件监视：递归 fs.watch + 轮询兜底 + 防抖。
 *
 * 方法：优先 fs.watch(root,{recursive:true})；watcher 出错（exFAT、网络盘等不支持
 *      递归监视）时自动切换到按 mtime 的快照轮询。
 * 对象：一个项目根下的 tracked 源文件变化；命中后合并成一批回调。
 */
import { watch } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 轮询兜底默认间隔。 */
const POLL_MS = 1500
/** 轮询最多走访的目录数。 */
const POLL_MAX_DIRS = 500

/**
 * 判断一个路径是否属于需要忽略的区域。
 * @param {string} relativePath - 相对项目根的路径（已统一分隔符）
 * @returns {boolean}
 */
function ignored(relativePath) {
  if (relativePath === '' || relativePath === '.') return false
  for (const segment of relativePath.split(/[\\/]/)) {
    if (segment === 'node_modules' || segment === '.dsh-latex' || segment === '.git') return true
    if (segment.startsWith('.') && segment.length > 1) return true
  }
  return false
}

/** 是否是被追踪的源文件。 */
function tracked(name, exts) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return exts.has(name.slice(dot).toLowerCase())
}

/**
 * 创建一个监视器。
 * @param {{root:string,exts:string[],debounceMs?:number,
 *          onBatch:(paths:string[])=>void,onError?:(error:unknown)=>void}} options
 * @returns {{close:()=>void,mode:()=>'watch'|'poll'}}
 */
export function createWatcher(options) {
  const { root, exts, onBatch, onError } = options
  const debounceMs = options.debounceMs ?? 500
  const wanted = new Set(exts.map((ext) => ext.toLowerCase()))
  const pending = new Set()
  let timer = null
  let watcher = null
  let pollTimer = null
  let closed = false
  let currentMode = 'watch'

  const flush = () => {
    timer = null
    if (pending.size === 0) return
    const batch = [...pending]
    pending.clear()
    try {
      onBatch(batch)
    } catch (error) {
      onError?.(error)
    }
  }

  const queue = (relativePath) => {
    if (closed) return
    if (ignored(relativePath)) return
    const name = relativePath.split(/[\\/]/).pop() ?? ''
    if (!tracked(name, wanted)) return
    pending.add(relativePath)
    if (timer !== null) return
    timer = setTimeout(flush, debounceMs)
  }

  const startPolling = () => {
    if (closed || pollTimer !== null) return
    currentMode = 'poll'
    let snapshot = new Map()
    const scan = async () => {
      if (closed) return
      const next = new Map()
      let visited = 0
      const walk = async (dir, depth) => {
        if (visited >= POLL_MAX_DIRS || depth > 4) return
        visited += 1
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
            await walk(join(dir, entry.name), depth + 1)
            continue
          }
          if (!tracked(entry.name, wanted)) continue
          const abs = join(dir, entry.name)
          try {
            const info = await stat(abs)
            next.set(abs, `${info.mtimeMs}:${info.size}`)
          } catch {
            // 忽略瞬时消失的文件
          }
        }
      }
      await walk(root, 0)
      if (snapshot.size > 0) {
        for (const [abs, signature] of next) {
          if (snapshot.get(abs) !== signature) queue(abs.slice(root.length + 1))
        }
        for (const abs of snapshot.keys()) {
          if (!next.has(abs)) queue(abs.slice(root.length + 1))
        }
      }
      snapshot = next
    }
    void scan()
    pollTimer = setInterval(() => { void scan() }, POLL_MS)
  }

  try {
    watcher = watch(root, { recursive: true, persistent: false }, (eventType, filename) => {
      if (closed) return
      if (filename === null || filename === undefined) {
        queue('')
        return
      }
      queue(String(filename))
    })
    watcher.on('error', (error) => {
      onError?.(error)
      try {
        watcher?.close()
      } catch {
        // 已经关闭
      }
      watcher = null
      startPolling()
    })
  } catch (error) {
    onError?.(error)
    startPolling()
  }

  return {
    close() {
      closed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      try {
        watcher?.close()
      } catch {
        // 忽略
      }
      watcher = null
    },
    mode: () => currentMode,
  }
}
