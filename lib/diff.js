/**
 * 行级 diff（patience 风格），无第三方依赖。
 *
 * 方法：先剥公共前缀/后缀，再用「在两段中都唯一出现的行」作锚点（patience），
 *      对锚点取 b 侧下标的最长递增子序列保证单调，然后在锚点之间递归；
 *      没有锚点的区间退化为「整块替换」。
 * 对象：两份文本（基线 vs 工作副本），输出编辑脚本（= / - / +）与按上下文分组的 hunk，
 *      供右侧栏「变更」视图渲染 unified 或并排对比。
 *
 * 为什么不用 Myers：它的回溯需要 O(D^2) 记忆；这里只关心"哪几段变了"，
 * patience 对论文/代码这类有大量唯一行的文本质量足够，且内存稳定。
 */

/** 单边超过该行数就不再逐行比较，改为整文件摘要。 */
const DEFAULT_MAX_LINES = 20000

/**
 * 把文本切成行（兼容 CRLF / CR / LF；末尾换行不额外产生空行）。
 * @param {string} text - 原文
 * @returns {string[]} 行数组
 */
export function splitLines(text) {
  if (typeof text !== 'string' || text === '') return []
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 计算两份文本的行级差异。
 * @param {string} oldText - 基线文本
 * @param {string} newText - 工作副本文本
 * @param {{maxLines?:number, context?:number}} [options]
 * @returns {{hunks:Array, additions:number, deletions:number, truncated:boolean,
 *            oldLines:number, newLines:number}}
 */
export function diffLines(oldText, newText, options = {}) {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const a = splitLines(oldText)
  const b = splitLines(newText)
  if (a.length > maxLines || b.length > maxLines) {
    return { hunks: [], additions: 0, deletions: 0, truncated: true, oldLines: a.length, newLines: b.length }
  }
  const ops = []
  diffRange(a, 0, a.length, b, 0, b.length, ops, 0)
  let additions = 0
  let deletions = 0
  for (const op of ops) {
    if (op.type === '+') additions += 1
    else if (op.type === '-') deletions += 1
  }
  return {
    hunks: toHunks(ops, options.context ?? 3),
    additions,
    deletions,
    truncated: false,
    oldLines: a.length,
    newLines: b.length,
  }
}

/** 递归消解一个区间（剥前后缀 → 找锚点 → 递归）。 */
function diffRange(a, a0, a1, b, b0, b1, ops, depth) {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
    ops.push({ type: '=', text: a[a0] })
    a0 += 1
    b0 += 1
  }
  const suffix = []
  while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) {
    a1 -= 1
    b1 -= 1
    suffix.push(a[a1])
  }
  if (a0 >= a1) {
    for (let j = b0; j < b1; j += 1) ops.push({ type: '+', text: b[j] })
  } else if (b0 >= b1) {
    for (let i = a0; i < a1; i += 1) ops.push({ type: '-', text: a[i] })
  } else if (depth > 200) {
    // 病态输入（大量重复行）直接整块替换，避免递归失控。
    for (let i = a0; i < a1; i += 1) ops.push({ type: '-', text: a[i] })
    for (let j = b0; j < b1; j += 1) ops.push({ type: '+', text: b[j] })
  } else {
    const anchors = findAnchors(a, a0, a1, b, b0, b1)
    if (anchors.length === 0) {
      for (let i = a0; i < a1; i += 1) ops.push({ type: '-', text: a[i] })
      for (let j = b0; j < b1; j += 1) ops.push({ type: '+', text: b[j] })
    } else {
      let ai = a0
      let bj = b0
      for (const anchor of anchors) {
        diffRange(a, ai, anchor[0], b, bj, anchor[1], ops, depth + 1)
        ops.push({ type: '=', text: a[anchor[0]] })
        ai = anchor[0] + 1
        bj = anchor[1] + 1
      }
      diffRange(a, ai, a1, b, bj, b1, ops, depth + 1)
    }
  }
  for (let i = suffix.length - 1; i >= 0; i -= 1) ops.push({ type: '=', text: suffix[i] })
}

/** 在两段区间里找「唯一匹配行」锚点，并取最长递增子序列。 */
function findAnchors(a, a0, a1, b, b0, b1) {
  const table = new Map()
  for (let i = a0; i < a1; i += 1) {
    const entry = table.get(a[i]) ?? { ac: 0, bc: 0, ai: -1, bi: -1 }
    entry.ac += 1
    entry.ai = i
    table.set(a[i], entry)
  }
  for (let j = b0; j < b1; j += 1) {
    const entry = table.get(b[j])
    if (entry === undefined) continue
    entry.bc += 1
    entry.bi = j
  }
  const pairs = []
  for (const entry of table.values()) {
    if (entry.ac === 1 && entry.bc === 1) pairs.push([entry.ai, entry.bi])
  }
  if (pairs.length <= 1) return pairs
  pairs.sort((p, q) => p[0] - q[0])
  return longestIncreasing(pairs)
}

/** 按第二维取最长递增子序列（返回原始 pair 列表）。 */
function longestIncreasing(pairs) {
  const tails = []
  const tailIndex = []
  const prev = new Array(pairs.length).fill(-1)
  for (let i = 0; i < pairs.length; i += 1) {
    const value = pairs[i][1]
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < value) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tailIndex[lo - 1]
    tails[lo] = value
    tailIndex[lo] = i
  }
  const out = []
  let cursor = tails.length === 0 ? -1 : tailIndex[tails.length - 1]
  while (cursor >= 0) {
    out.push(pairs[cursor])
    cursor = prev[cursor]
  }
  out.reverse()
  return out
}

/**
 * 把编辑脚本切成带上下文的 hunk。
 * @param {Array<{type:string,text:string}>} ops - 编辑脚本
 * @param {number} context - 上下文行数
 * @returns {Array<{oldStart:number,oldLines:number,newStart:number,newLines:number,
 *                  body:Array<{type:string,text:string,oldLine?:number,newLine?:number}>}>}
 */
export function toHunks(ops, context = 3) {
  const lines = []
  let oldLine = 0
  let newLine = 0
  for (const op of ops) {
    if (op.type === '=') {
      oldLine += 1
      newLine += 1
      lines.push({ type: '=', text: op.text, oldLine, newLine })
    } else if (op.type === '-') {
      oldLine += 1
      lines.push({ type: '-', text: op.text, oldLine })
    } else {
      newLine += 1
      lines.push({ type: '+', text: op.text, newLine })
    }
  }
  const oldBefore = new Array(lines.length + 1).fill(0)
  const newBefore = new Array(lines.length + 1).fill(0)
  for (let i = 0; i < lines.length; i += 1) {
    oldBefore[i + 1] = oldBefore[i] + (lines[i].type === '+' ? 0 : 1)
    newBefore[i + 1] = newBefore[i] + (lines[i].type === '-' ? 0 : 1)
  }
  const changed = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].type !== '=') changed.push(i)
  }
  const hunks = []
  let g = 0
  while (g < changed.length) {
    const first = changed[g]
    let last = first
    let h = g + 1
    while (h < changed.length && changed[h] - last <= 2 * context + 1) {
      last = changed[h]
      h += 1
    }
    const from = Math.max(0, first - context)
    const to = Math.min(lines.length - 1, last + context)
    const oldLines = oldBefore[to + 1] - oldBefore[from]
    const newLines = newBefore[to + 1] - newBefore[from]
    hunks.push({
      oldStart: oldLines === 0 ? oldBefore[from] : oldBefore[from] + 1,
      oldLines,
      newStart: newLines === 0 ? newBefore[from] : newBefore[from] + 1,
      newLines,
      body: lines.slice(from, to + 1),
    })
    g = h
  }
  return hunks
}
