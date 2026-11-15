/**
 * 变更审阅：基线 vs 工作副本的差异集合、逐文件 diff、接受与放弃。
 *
 * 方法：用 sha256 判等（按 mtime+size 缓存，避免每次轮询重读），用 lib/diff.js 生成
 *      hunk；"接受"把当前内容写入基线，"放弃"把基线写回文件并用 mtime 做 CAS，
 *      防止覆盖用户/agent 在此期间更新的内容。
 * 对象：一个 LaTeX 项目里被追踪的源文件。
 */
import { stat, unlink, writeFile } from 'node:fs/promises'
import { diffLines, splitLines } from './diff.js'
import { listSourceFiles, readTextFile, safeResolve } from './source-files.js'
import { sha256 } from './baseline.js'

/** diff 文本返回的上限（字节），超过则只给统计。 */
const DIFF_TEXT_CAP = 256 * 1024

/**
 * 创建审阅器。
 * @param {{root:string,settings:object,baseline:object}} input
 * @returns {object} 审阅器
 */
export function createReview({ root, settings, baseline }) {
  /** rel -> {mtimeMs,size,hash,text?} 的读取缓存 */
  const cache = new Map()
  /** `${baseHash}:${hash}` -> {additions,deletions} */
  const deltaCache = new Map()

  const absolute = (relPath) => safeResolve(root, relPath)

  const currentFile = async (relPath) => {
    const abs = absolute(relPath)
    if (abs === null) return null
    let info
    try {
      info = await stat(abs)
    } catch {
      return null
    }
    const cached = cache.get(relPath)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached
    let text
    try {
      text = (await readTextFile(abs, settings.maxReviewBytes ?? 2 * 1024 * 1024)).text
    } catch {
      return null
    }
    const record = { rel: relPath, abs, size: info.size, mtimeMs: info.mtimeMs, text, hash: sha256(text) }
    cache.set(relPath, record)
    return record
  }

  const listCurrent = async () => {
    const files = await listSourceFiles(root, {
      trackExts: settings.trackExts,
      maxFiles: 400,
      maxBytes: settings.maxReviewBytes ?? 2 * 1024 * 1024,
    })
    const out = []
    for (const file of files) {
      const record = await currentFile(file.rel)
      if (record !== null) out.push(record)
    }
    return out
  }

  const deltaOf = async (relPath, baseEntry, record) => {
    const key = `${baseEntry.sha256}:${record.hash}`
    const cached = deltaCache.get(key)
    if (cached !== undefined) return cached
    const oldText = (await baseline.readText(relPath)) ?? ''
    const result = diffLines(oldText, record.text, { context: 2 })
    const value = { additions: result.additions, deletions: result.deletions }
    deltaCache.set(key, value)
    return value
  }

  return {
    /**
     * 当前变更集合。
     * @returns {Promise<Array<{path:string,status:'added'|'modified'|'deleted',
     *          additions:number,deletions:number,mtimeMs:number|null,size:number|null}>>}
     */
    async changes() {
      await baseline.load()
      const current = await listCurrent()
      const byRel = new Map(current.map((record) => [record.rel, record]))
      const out = []
      for (const record of current) {
        const baseEntry = baseline.entry(record.rel)
        if (baseEntry === undefined) {
          out.push({
            path: record.rel,
            status: 'added',
            additions: record.text === '' ? 0 : record.text.split(/\r\n|\n|\r/).length,
            deletions: 0,
            mtimeMs: record.mtimeMs,
            size: record.size,
          })
          continue
        }
        if (baseEntry.sha256 === record.hash) continue
        const delta = await deltaOf(record.rel, baseEntry, record)
        out.push({ path: record.rel, status: 'modified', ...delta, mtimeMs: record.mtimeMs, size: record.size })
      }
      for (const relPath of baseline.list()) {
        if (byRel.has(relPath)) continue
        const baseEntry = baseline.entry(relPath)
        out.push({
          path: relPath,
          status: 'deleted',
          additions: 0,
          deletions: baseEntry?.lines ?? 0,
          mtimeMs: null,
          size: null,
        })
      }
      out.sort((a, b) => a.path.localeCompare(b.path))
      return out
    },

    /**
     * 单个文件的差异详情。
     * @param {string} relPath
     * @returns {Promise<object|null>}
     */
    async diff(relPath) {
      await baseline.load()
      const baseEntry = baseline.entry(relPath)
      const record = await currentFile(relPath)
      if (baseEntry === undefined && record === null) return null
      const oldText = (await baseline.readText(relPath)) ?? ''
      const newText = record?.text ?? ''
      const status = baseEntry === undefined ? 'added' : record === null ? 'deleted' : baseEntry.sha256 === record.hash ? 'unchanged' : 'modified'
      if (status === 'unchanged') {
        return {
          path: relPath,
          status,
          additions: 0,
          deletions: 0,
          hunks: [],
          truncated: false,
          oldText: '',
          newText: '',
          currentMtimeMs: record?.mtimeMs ?? null,
          baseMtimeMs: baseEntry?.mtimeMs ?? null,
        }
      }
      const result = diffLines(oldText, newText, { context: 3 })
      const cap = (text) => (Buffer.byteLength(text, 'utf8') > DIFF_TEXT_CAP ? text.slice(0, DIFF_TEXT_CAP) : text)
      return {
        path: relPath,
        status,
        additions: result.additions,
        deletions: result.deletions,
        hunks: result.hunks,
        truncated: result.truncated,
        oldText: cap(oldText),
        newText: cap(newText),
        currentMtimeMs: record?.mtimeMs ?? null,
        baseMtimeMs: baseEntry?.mtimeMs ?? null,
      }
    },

    /**
     * 逐 hunk 决策：接受→新行，放弃→旧行，未决定→工作副本保留新行、基线保留旧行。
     * @param {string} relPath
     * @param {{accept?:number[], reject?:number[]}} decisions - hunk 序号（0 基）
     * @returns {Promise<{path:string, decided:number, remaining:number}>}
     */
    async decide(relPath, decisions = {}) {
      await baseline.load()
      const baseEntry = baseline.entry(relPath)
      const abs = absolute(relPath)
      const record = await currentFile(relPath)
      if (abs === null || baseEntry === undefined || record === null) {
        throw new Error(`无法决策未跟踪或已删除的文件: ${relPath}`)
      }
      const baseText = (await baseline.readText(relPath)) ?? ''
      const currentText = record.text
      const result = diffLines(baseText, currentText, { context: 3 })
      if (result.truncated) throw new Error('文件过大，无法逐段决策')
      const accept = new Set((decisions.accept ?? []).filter((index) => Number.isInteger(index)))
      const reject = new Set((decisions.reject ?? []).filter((index) => Number.isInteger(index)))
      const oldLines = splitLines(baseText)
      const newLines = splitLines(currentText)
      const workingOut = []
      const baseOut = []
      let cursor = 0
      for (let index = 0; index < result.hunks.length; index += 1) {
        const hunk = result.hunks[index]
        // 纯插入 hunk 的 start 是"插入位置"（0 基），其余是 1 基行号。
        const oldFrom = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1
        const newFrom = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1
        const oldSlice = oldLines.slice(oldFrom, oldFrom + hunk.oldLines)
        const newSlice = newLines.slice(newFrom, newFrom + hunk.newLines)
        for (const line of oldLines.slice(cursor, oldFrom)) {
          workingOut.push(line)
          baseOut.push(line)
        }
        if (reject.has(index)) {
          workingOut.push(...oldSlice)
          baseOut.push(...oldSlice)
        } else if (accept.has(index)) {
          workingOut.push(...newSlice)
          baseOut.push(...newSlice)
        } else {
          workingOut.push(...newSlice)
          baseOut.push(...oldSlice)
        }
        cursor = oldFrom + hunk.oldLines
      }
      for (const line of oldLines.slice(cursor)) {
        workingOut.push(line)
        baseOut.push(line)
      }
      const tail = baseText.endsWith('\n') || currentText.endsWith('\n') ? '\n' : ''
      const joinLines = (lines) => (lines.length === 0 ? tail : lines.join('\n') + tail)
      const workingText = joinLines(workingOut)
      const baselineText = joinLines(baseOut)
      if (workingText === currentText && baselineText === baseText) return { path: relPath, decided: 0, remaining: result.hunks.length }
      await writeFile(abs, workingText, 'utf8')
      await baseline.capture(relPath, baselineText)
      await baseline.save()
      cache.delete(relPath)
      const after = diffLines(baselineText, workingText, { context: 3 })
      return { path: relPath, decided: accept.size + reject.size, remaining: after.hunks.length }
    },

    async accept(paths) {
      await baseline.load()
      const accepted = []
      for (const relPath of paths) {
        if (absolute(relPath) === null) continue
        const record = await currentFile(relPath)
        if (record === null) {
          // 文件已删除：接受删除，移除基线条目
          if (baseline.entry(relPath) !== undefined) {
            await baseline.remove(relPath)
            accepted.push(relPath)
          }
          continue
        }
        const baseEntry = baseline.entry(relPath)
        if (baseEntry !== undefined && baseEntry.sha256 === record.hash) continue
        await baseline.capture(relPath, record.text, { mtimeMs: record.mtimeMs })
        accepted.push(relPath)
      }
      if (accepted.length > 0) await baseline.save()
      return { accepted }
    },

    /**
     * 放弃若干文件的改动：把基线写回文件（新增文件则删除）。
     * @param {string[]} paths
     * @param {number} [expectedMtimeMs] - 展示 diff 时的 mtime，用于 CAS
     * @returns {Promise<{rejected:string[],conflicts:string[]}>}
     */
    async reject(paths, expectedMtimeMs) {
      await baseline.load()
      const rejected = []
      const conflicts = []
      for (const relPath of paths) {
        const abs = absolute(relPath)
        if (abs === null) {
          conflicts.push(relPath)
          continue
        }
        let info = null
        try {
          info = await stat(abs)
        } catch {
          info = null
        }
        if (
          expectedMtimeMs !== undefined &&
          expectedMtimeMs !== null &&
          info !== null &&
          Math.abs(info.mtimeMs - expectedMtimeMs) > 2
        ) {
          conflicts.push(relPath)
          continue
        }
        const baseEntry = baseline.entry(relPath)
        const current = await currentFile(relPath)
        // 没有未审阅改动：跳过，别重写文件（会无谓刷新 mtime、触发重编译）
        if (baseEntry !== undefined && current !== null && baseEntry.sha256 === current.hash) continue
        if (baseEntry === undefined && current === null) continue
        try {
          if (baseEntry === undefined) {
            // 新增文件：放弃 = 删除它（仍是展示时的那份内容才删）
            if (info !== null) await unlink(abs)
          } else {
            const text = await baseline.readText(relPath)
            if (text === null) {
              conflicts.push(relPath)
              continue
            }
            await writeFile(abs, text, 'utf8')
          }
          cache.delete(relPath)
          rejected.push(relPath)
        } catch {
          conflicts.push(relPath)
        }
      }
      return { rejected, conflicts }
    },
  }
}
