/**
 * 变更基线：保存"用户已接受"的源文件副本与哈希清单。
 *
 * 方法：`.dsh-latex/baseline/manifest.json` 记录每个文件的 sha256/size/mtime，
 *      `files/<相对路径>` 保存内容副本。项目首次打开时以当前文件初始化；
 *      之后只有"接受"会更新基线，编译不会（否则 agent 的改动会被自动吞掉）。
 * 对象：一个项目的已接受版本快照。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * 文本的 sha256。
 * @param {string} text
 * @returns {string}
 */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 创建一个基线仓库。
 * @param {{root:string,dir:string}} input - 项目根与基线目录（绝对）
 * @returns {object} 基线仓库
 */
export function createBaseline({ root, dir }) {
  const filesDir = join(dir, 'files')
  const manifestPath = join(dir, 'manifest.json')
  /** @type {Record<string,{sha256:string,size:number,mtimeMs:number,lines:number}>} */
  let manifest = {}
  let loaded = false

  const storagePath = (relPath) => {
    const abs = resolve(filesDir, relPath.split('/').join(sep))
    const back = relative(filesDir, abs)
    if (back.startsWith('..') || back === '') throw new Error(`基线路径越界: ${relPath}`)
    return abs
  }

  return {
    /** 读取 manifest（只读一次）。 */
    async load() {
      if (loaded) return
      loaded = true
      try {
        const text = await readFile(manifestPath, 'utf8')
        const parsed = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object') manifest = parsed
      } catch {
        manifest = {}
      }
    },
    /** 已接受的文件清单。 */
    list() {
      return Object.keys(manifest)
    },
    /** 一个条目的元数据。 */
    entry(relPath) {
      return manifest[relPath]
    },
    /** 保存 manifest。 */
    async save() {
      await mkdir(dir, { recursive: true })
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    },
    /**
     * 读取基线的文件内容。
     * @param {string} relPath
     * @returns {Promise<string|null>}
     */
    async readText(relPath) {
      try {
        return await readFile(storagePath(relPath), 'utf8')
      } catch {
        return null
      }
    },
    /**
     * 把一份内容记为"已接受"。
     * @param {string} relPath
     * @param {string} text
     * @param {{mtimeMs?:number}} [meta]
     */
    async capture(relPath, text, meta = {}) {
      const abs = storagePath(relPath)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, text, 'utf8')
      manifest[relPath] = {
        sha256: sha256(text),
        size: Buffer.byteLength(text, 'utf8'),
        mtimeMs: Number(meta.mtimeMs ?? Date.now()),
        lines: text === '' ? 0 : text.split(/\r\n|\n|\r/).length,
      }
    },
    /**
     * 移除一个基线条目（文件被接受删除时）。
     * @param {string} relPath
     */
    async remove(relPath) {
      delete manifest[relPath]
      try {
        await rm(storagePath(relPath), { force: true })
      } catch {
        // 副本不存在也无所谓
      }
    },
    /**
     * 批量初始化：为尚无基线条目的文件记录当前内容（项目首次打开时调用）。
     * @param {Array<{rel:string,text:string,mtimeMs:number}>} files
     * @returns {Promise<number>} 新增的条目数
     */
    async init(files) {
      let added = 0
      for (const file of files) {
        if (manifest[file.rel] !== undefined) continue
        await this.capture(file.rel, file.text, { mtimeMs: file.mtimeMs })
        added += 1
      }
      if (added > 0) await this.save()
      return added
    },
  }
}
