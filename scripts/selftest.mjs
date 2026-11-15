/**
 * 无 DSH 运行时的自检：直接驱动 project store，验证编译、SyncTeX、变更审阅三条链路。
 *
 * 运行：node scripts/selftest.mjs
 * 会在 example/ 下生成 .dsh-latex/（结束时删除），不触碰其它目录。
 */
import assert from 'node:assert/strict'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectStore } from '../lib/project.js'

const root = join(process.cwd(), 'example')
const texPath = join(root, 'paper.tex')
const store = createProjectStore({})
const results = []

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push(`PASS ${name}`)
    })
    .catch((error) => {
      results.push(`FAIL ${name}: ${error.message}`)
    })
}

async function cleanup() {
  store.dispose()
  await rm(join(root, '.dsh-latex'), { recursive: true, force: true })
}

try {
  const original = await readFile(texPath, 'utf8')
  const project = await store.ensure(root)
  await store.updateSettings(project, { autoCompile: false })
  project.watcher?.close()
  project.watcher = null

  await check('detect main file', () => {
    assert.equal(project.mainFileRel, 'paper.tex')
  })

  await check('toolchain found', () => {
    assert.ok(project.toolchain !== null, 'probeToolchain returned null')
    assert.ok(project.toolchain.latexmk.endsWith('latexmk.exe'))
  })

  let compiled = null
  await check('compile succeeds', async () => {
    compiled = await store.compile(project, { reason: 'selftest' })
    assert.equal(compiled.ok, true, JSON.stringify(compiled.errors))
    assert.ok(compiled.pages >= 1, 'pages missing')
    assert.equal(project.state, 'ok')
  })

  await check('synctex round trip', async () => {
    assert.ok(project.pdfAbs !== null, 'no pdf path')
    const view = await store.syncView(project, { line: 20 })
    assert.equal(view.ok, true, 'forward search failed')
    assert.ok(view.page >= 1)
    const edit = await store.syncEdit(project, { page: view.page, x: view.x + 2, y: view.y - 1 })
    assert.equal(edit.ok, true, 'inverse search failed')
    assert.equal(edit.file, 'paper.tex')
    assert.ok(Math.abs(edit.line - 20) <= 2, `line ${edit.line} not near 20`)
  })

  await check('figure and bibliography resolve', async () => {
    const buildDir = join(root, '.dsh-latex', 'build')
    const log = await readFile(join(buildDir, 'paper.log'), 'utf8')
    assert.ok(!/File `[^']*' not found/.test(log), 'some \\input or figure was not found')
    assert.ok(!/Citation `[^']*' on page \d+ undefined/.test(log), 'undefined citation in log')
    assert.ok(log.includes('phase.pdf'), 'figure was never opened by TeX')
    const bbl = await readFile(join(buildDir, 'paper.bbl'), 'utf8').catch(() => '')
    assert.ok(bbl.includes('bibitem'), 'no .bbl produced (bibtex did not run)')
  })

  await check('synctex reaches included file', async () => {
    const appendixPath = join(root, 'sections', 'appendix.tex')
    const appendix = await readFile(appendixPath, 'utf8')
    const line = appendix.split(/\r\n|\n|\r/).findIndex((text) => text.includes('This paragraph lives in')) + 1
    assert.ok(line > 0, 'marker paragraph missing in appendix')
    const view = await store.syncView(project, { file: 'sections/appendix.tex', line })
    assert.equal(view.ok, true, 'forward search into included file failed')
    const edit = await store.syncEdit(project, { page: view.page, x: view.x + 2, y: view.y - 1 })
    assert.equal(edit.ok, true, 'inverse search from included file failed')
    assert.equal(edit.file, 'sections/appendix.tex', `inverse search returned ${edit.file}`)
  })

  await check('pdf rect resolves to a line range', async () => {
    const first = await store.syncView(project, { line: 20 })
    const last = await store.syncView(project, { line: 23 })
    assert.equal(first.ok, true, 'forward search failed')
    assert.equal(last.ok, true, 'forward search failed')
    assert.equal(first.page, last.page, 'paragraph unexpectedly spans pages')
    const top = Math.min(first.y - (first.height || 10), last.y - (last.height || 10)) - 4
    const bottom = Math.max(first.y, last.y) + 4
    const range = await store.syncRange(project, {
      page: first.page,
      x: 90,
      y: Math.max(0, top),
      w: 400,
      h: Math.max(12, bottom - top),
    })
    assert.equal(range.ok, true, 'range failed')
    assert.equal(range.file, 'paper.tex')
    assert.ok(range.line <= 20, `line ${range.line} > 20`)
    assert.ok(range.endLine >= 21, `endLine ${range.endLine} < 21`)
    assert.ok(range.endLine - range.line >= 1, `range collapsed to ${range.line}-${range.endLine}`)
    assert.ok(Array.isArray(range.groups) && range.groups.length >= 1, 'groups missing')
  })

  await check('single-line rect stays single line', async () => {
    const view = await store.syncView(project, { line: 21 })
    assert.equal(view.ok, true, 'forward search failed')
    const height = view.height || 10
    const range = await store.syncRange(project, {
      page: view.page,
      x: Math.max(0, view.x),
      y: Math.max(0, view.y - height),
      w: Math.max(24, view.width || 40),
      h: height,
    })
    assert.equal(range.ok, true, 'range failed')
    assert.ok(range.endLine - range.line <= 1, `expanded to ${range.line}-${range.endLine}`)
  })

  await check('rect in an included file resolves to that file', async () => {
    const appendixPath = join(root, 'sections', 'appendix.tex')
    const appendix = await readFile(appendixPath, 'utf8')
    const line = appendix.split(/\r\n|\n|\r/).findIndex((text) => text.includes('This paragraph lives in')) + 1
    const view = await store.syncView(project, { file: 'sections/appendix.tex', line })
    assert.equal(view.ok, true, 'forward search into included file failed')
    const height = view.height || 10
    const range = await store.syncRange(project, {
      page: view.page,
      x: Math.max(0, view.x - 10),
      y: Math.max(0, view.y - height - 2),
      w: 300,
      h: height + 4,
    })
    assert.equal(range.ok, true, 'range failed')
    assert.equal(range.file, 'sections/appendix.tex', `range returned ${range.file}`)
  })

  await check('clean baseline', async () => {
    const changes = await store.changesOf(project)
    assert.equal(changes.count, 0, JSON.stringify(changes.files))
  })

  await check('detect a modification', async () => {
    const edited = original.replace('This is the first paragraph', 'This is the first paragraph (edited by the agent)')
    await writeFile(texPath, edited, 'utf8')
    project.changesCache = { at: 0, value: { count: 0, files: [] } }
    const changes = await store.changesOf(project)
    assert.equal(changes.count, 1, JSON.stringify(changes.files))
    assert.equal(changes.files[0].path, 'paper.tex')
    assert.equal(changes.files[0].status, 'modified')
    assert.ok(changes.files[0].additions >= 1)
    const diff = await project.review.diff('paper.tex')
    assert.ok(diff.hunks.length >= 1)
    const text = diff.hunks.flatMap((hunk) => hunk.body.map((line) => `${line.type}${line.text}`)).join('\n')
    assert.ok(text.includes('edited by the agent'), 'diff body missing the edit')
  })

  await check('reject restores the baseline', async () => {
    const rejected = await project.review.reject(['paper.tex'])
    assert.deepEqual(rejected.conflicts, [])
    assert.equal(rejected.rejected.length, 1)
    const restored = await readFile(texPath, 'utf8')
    assert.equal(restored, original)
    project.changesCache = { at: 0, value: { count: 0, files: [] } }
    const changes = await store.changesOf(project)
    assert.equal(changes.count, 0)
  })

  await check('reject on unchanged file is a no-op', async () => {
    const beforeInfo = await stat(texPath)
    const result = await project.review.reject(['paper.tex'])
    assert.deepEqual(result.rejected, [], 'clean file was reported as rejected')
    const afterInfo = await stat(texPath)
    assert.equal(afterInfo.mtimeMs, beforeInfo.mtimeMs, 'clean file was rewritten')
  })

  await check('detect change in an included file', async () => {
    const appendixPath = join(root, 'sections', 'appendix.tex')
    const before = await readFile(appendixPath, 'utf8')
    await writeFile(appendixPath, `${before}\n% edited-in-selftest\n`, 'utf8')
    project.changesCache = { at: 0, value: { count: 0, files: [] } }
    const changes = await store.changesOf(project)
    const entry = changes.files.find((file) => file.path === 'sections/appendix.tex')
    assert.ok(entry !== undefined, JSON.stringify(changes.files))
    assert.equal(entry.status, 'modified')
    const diff = await project.review.diff('sections/appendix.tex')
    assert.ok(diff.hunks.length >= 1)
    const rejected = await project.review.reject(['sections/appendix.tex'])
    assert.deepEqual(rejected.conflicts, [])
    assert.equal(await readFile(appendixPath, 'utf8'), before)
    project.changesCache = { at: 0, value: { count: 0, files: [] } }
  })

  await check('accept updates the baseline', async () => {
    const edited = `${original}\n% accepted-by-selftest\n`
    await writeFile(texPath, edited, 'utf8')
    project.changesCache = { at: 0, value: { count: 0, files: [] } }
    let changes = await store.changesOf(project)
    assert.equal(changes.count, 1)
    await project.review.accept(['paper.tex'])
    project.changesCache = { at: 0, value: { count: 0, files: [] } }
    changes = await store.changesOf(project)
    assert.equal(changes.count, 0)
  })

  await check('recompile after accept', async () => {
    const recompiled = await store.compile(project, { reason: 'selftest' })
    assert.equal(recompiled.ok, true, JSON.stringify(recompiled.errors))
  })

  await check('baseline compare builds', async () => {
    const state = await store.ensureCompare(project)
    assert.equal(state.state, 'ready', state.message ?? '')
    assert.ok(state.pdfAbs !== null && state.pdfAbs.endsWith('.pdf'))
  })

  await check('review anchors + per-hunk decide + undo', async () => {
    const before = await readFile(texPath, 'utf8')
    const edited = before
      .replace('This is the first paragraph of the acceptance document.', 'This is the first paragraph of the acceptance document. EDITED-ONE')
      .replace('If all three checks pass', 'If all three checks pass. EDITED-TWO')
    await writeFile(texPath, edited, 'utf8')
    project.reviewCache = { key: null, value: null }
    const review = await store.reviewOf(project, 'paper.tex', { ensure: true })
    assert.ok(review.changes.length >= 2, `expected >=2 changes, got ${review.changes.length}`)
    assert.ok(review.changes[0].after !== null, 'missing after anchor')
    assert.ok(review.changes[0].before !== null, 'missing before anchor')
    await store.decide(project, 'paper.tex', { accept: [0], reject: [1] })
    const decided = await readFile(texPath, 'utf8')
    assert.ok(decided.includes('EDITED-ONE'), 'accepted change missing')
    assert.ok(!decided.includes('EDITED-TWO'), 'rejected change not reverted')
    await store.undo(project)
    const undone = await readFile(texPath, 'utf8')
    assert.ok(undone.includes('EDITED-ONE') && undone.includes('EDITED-TWO'), 'undo did not restore pending edits')
    await writeFile(texPath, before, 'utf8')
    await project.review.accept(['paper.tex'])
    project.reviewCache = { key: null, value: null }
    project.changesCache = { at: 0, value: { count: 0, files: [] } }
  })

  await check('notes persist', async () => {
    await store.writeNotes(project, [
      { id: 'n1', page: 1, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 }, file: 'paper.tex', line: 18, note: '测试批注', createdAt: 1 },
    ])
    const read = await store.readNotes(project)
    assert.equal(read.notes.length, 1)
    assert.equal(read.notes[0].id, 'n1')
    await store.writeNotes(project, [])
  })

  await check('range note keeps endLine and multi-line quote', async () => {
    const note = {
      id: 'n2',
      page: 1,
      rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
      file: 'paper.tex',
      line: 20,
      endLine: 23,
      quote: 'This is the first paragraph.\nover several lines.',
      note: '这段压缩成两句',
      createdAt: 2,
    }
    await store.writeNotes(project, [note])
    const read = await store.readNotes(project)
    assert.equal(read.notes.length, 1)
    assert.equal(read.notes[0].endLine, 23)
    assert.ok(String(read.notes[0].quote).includes('\n'), 'multi-line quote lost its newline')
    await store.writeNotes(project, [])
  })

  await writeFile(texPath, original, 'utf8')
} finally {
  await cleanup()
}

for (const line of results) console.log(line)
const failed = results.filter((line) => line.startsWith('FAIL'))
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
