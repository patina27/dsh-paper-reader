// 精读（digest）：抽取 / 分节 / 任务规划 / 引句定位 / 编排引擎（假子代理）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const REPO = new URL('..', import.meta.url).pathname
const load = (m) => import(pathToFileURL(join(REPO, 'dist', m)).href)
const X = await load('digest-extract.js')
const D = await load('digest.js')
const R = await load('digest-run.js')
const L = await load('library.js')

/** 合成一张页：lines = [{text, x, y, h?, eol?}]，每行拆成按词的 item（模拟 OCR 层）。 */
function page(n, width, height, lines) {
  const items = []
  for (const l of lines) {
    const h = l.h ?? 10
    let x = l.x
    const words = l.text.split(' ')
    words.forEach((w, i) => {
      const wdt = w.length * h * 0.5
      items.push({ str: w, x, y: l.y, w: wdt, h, eol: i === words.length - 1 })
      x += wdt + h * 0.3
    })
  }
  return { page: n, width, height, items }
}

test('抽取：跨页拆成两页书、页眉剔除并取页码、缩进断段、行尾断词愈合、罗马数字标题', () => {
  const L0 = 60, R0 = 520
  const left = [
    { text: '76 COMMON KNOWLEDGE', x: L0, y: 660 },
    { text: 'the Newtonian picture of nature was strictly fac-', x: L0, y: 630 },
    { text: 'tual and solely so in that period of history.', x: L0, y: 616 },
    { text: 'For present purposes the rights and wrongs are', x: L0 + 14, y: 602 },
    { text: 'not the point we wish to discuss here today and', x: L0, y: 588 },
    { text: 'more of the same text continues across the page', x: L0, y: 574 },
  ]
  const right = [
    { text: 'THE MARGINAL RELEVANCE OF THEORY 77', x: R0 + 100, y: 660 },
    { text: 'can only be pointed to and not stated in words.', x: R0, y: 630 },
    { text: 'II', x: R0 + 180, y: 600 },
    { text: 'The arguments of Feyerabend and Lyotard converge', x: R0 + 14, y: 570 },
    { text: 'on the presupposition that all our experiences are', x: R0, y: 556 },
  ]
  const p = page(1, 921, 700, [...left, ...right])
  const { paragraphs, notes } = X.paragraphsFromPages([p])
  assert.ok(notes.some((n) => /跨页/.test(n)), notes.join(';'))
  const texts = paragraphs.map((x) => x.text)
  assert.ok(!texts.some((t) => /COMMON KNOWLEDGE|MARGINAL RELEVANCE/.test(t)), '页眉必须剔除')
  assert.match(texts[0], /strictly factual and solely/, '行尾连字符断词愈合')
  assert.equal(paragraphs[0].label, '76')
  assert.match(texts[1], /^For present purposes/, '首行缩进断段')
  // 左页最后一段没以句末标点收尾、右页首行小写开头 → 续段
  assert.match(texts[1], /continues across the page can only be pointed to/, '跨页续段')
  const h = paragraphs.find((x) => x.text === 'II')
  assert.ok(h && h.kind === 'heading', 'II 是标题')
  assert.equal(h.label, '77')
  // spans 与文本对齐：每个 span 的区间都落在段落文本内
  for (const q of paragraphs) for (const s of q.spans) assert.ok(s[0] >= 0 && s[1] <= q.text.length && s[1] > s[0])
})

test('抽取：首字下沉合并（"T hose" → "Those"，且不另起一段）', () => {
  const p = page(1, 460, 700, [
    { text: 'Intro line one is here at the very top of the body text.', x: 60, y: 600 },
    { text: 'Second body line comes next in the same paragraph.', x: 60, y: 586 },
  ])
  p.items.push({ str: 'T ', x: 60, y: 540, w: 26, h: 38, eol: false })
  p.items.push({ str: 'hose who lived through the debate in the philosophy', x: 88, y: 556, w: 300, h: 10, eol: true })
  p.items.push({ str: 'over the last half century will recognize the precursors', x: 88, y: 542, w: 300, h: 10, eol: true })
  const { paragraphs } = X.paragraphsFromPages([p])
  const hit = paragraphs.find((x) => /hose who/.test(x.text))
  assert.match(hit.text, /^Those who lived .* over the last half century/)
})

test('引句定位：精确、大小写/引号/破折号差异、OCR 断词与错字', () => {
  const text = 'Kuhn’s achievement was to show that, in the nature of the case, paradigms were historical and cultural variables, so that there can be no permanently valid system.'
  const r1 = D.locateQuote(text, "paradigms were historical and cultural variables")
  assert.equal(text.slice(r1[0], r1[1]), 'paradigms were historical and cultural variables')
  const r2 = D.locateQuote(text, "Kuhn's achievement was to show that")
  assert.ok(r2 && text.slice(r2[0], r2[1]).startsWith('Kuhn'))
  // 引句里的一个 OCR 错字（cultnral）：锚点仍能定位
  const r3 = D.locateQuote(text, 'paradigms were historical and cultnral variables, so that there can be no permanently valid system')
  assert.ok(r3, '锚点定位应命中')
  assert.ok(text.slice(r3[0], r3[1]).includes('permanently valid system'))
  assert.equal(D.locateQuote(text, 'completely unrelated sentence about cooking pasta'), null)
})

function fakeDoc(n, heads = {}) {
  const paragraphs = []
  for (let i = 1; i <= n; i++) {
    const head = heads[i]
    paragraphs.push({
      id: `p${i}`, kind: head ? 'heading' : 'body', page: Math.ceil(i / 4), label: String(74 + Math.ceil(i / 4)),
      text: head ?? `Paragraph ${i} says something important about theory and practice in the humanities, number ${i}.`,
      spans: [[0, 20, Math.ceil(i / 4), 60, 600 - (i % 4) * 100, 300, 12]],
    })
  }
  return { source: 'pdfjs', pageCount: Math.ceil(n / 4), pageSizes: [], paragraphs, notes: [] }
}

test('分节：启发式按标题切、文首标题归第一节；outline 结果校验递增与覆盖', () => {
  const doc = fakeDoc(12, { 1: 'THE TITLE', 2: 'Author Name', 6: 'II', 10: 'III' })
  const h = D.heuristicSections(doc.paragraphs)
  assert.deepEqual(h.map((s) => [s.start, s.end]), [[1, 5], [6, 9], [10, 12]])
  const o = D.sectionsFromOutline(doc.paragraphs, [
    { startPid: 'p3', title: '引言' }, { startPid: 'p6', title: '第二节' }, { startPid: 'p4', title: '倒序被丢' }, { startPid: 'p99', title: '不存在被丢' }, { startPid: 'p10', title: '第三节' },
  ])
  assert.deepEqual(o.map((s) => [s.start, s.end, s.title]), [[1, 5, '引言'], [6, 9, '第二节'], [10, 12, '第三节']])
})

test('任务规划：每节一个分析 + 按词数切翻译块；已有结果跳过，force 全重来', () => {
  const doc = fakeDoc(40)
  const d = D.newDigest(doc, 'k')
  d.outline = { title: 'T', kind: 'essay', sections: [{ id: 's1', title: 'A', start: 1, end: 20 }, { id: 's2', title: 'B', start: 21, end: 40 }], source: 'model' }
  const t1 = D.planTasks(d, ['s1', 's2'], false)
  assert.equal(t1.filter((t) => t.kind === 'analyze').length, 2)
  const tr = t1.filter((t) => t.kind === 'translate')
  assert.ok(tr.length >= 2)
  assert.deepEqual(tr.flatMap((t) => t.pids), doc.paragraphs.map((p) => p.id), '翻译块按序覆盖全部段落')
  d.analyses.s1 = { summary: 'x', keyPoints: [], critique: '', eli5: '', highlights: [], figures: [] }
  for (const p of doc.paragraphs.slice(0, 20)) d.translations[p.id] = '译'
  const t2 = D.planTasks(d, ['s1', 's2'], false)
  assert.ok(t2.every((t) => t.kind === 'overview' || t.sectionId === 's2'))
  assert.ok(D.planTasks(d, ['s1'], true).some((t) => t.kind === 'analyze' && t.sectionId === 's1'))
  // 中文原文：不排翻译
  d.needsTranslation = false
  assert.ok(D.planTasks(d, ['s2'], true).every((t) => t.kind !== 'translate'))
})

function tempPaper(doc) {
  const dir = mkdtempSync(join(tmpdir(), 'dpr-digest-'))
  mkdirSync(join(dir, 'topic'))
  const pdf = join(dir, 'topic', 'paper.pdf')
  writeFileSync(pdf, '%PDF-1.4 fake')
  const ref = L.resolvePaper(dir, { path: pdf })
  return { ref, dir }
}

/** 按 schema 造结构化结果的假子代理。 */
function fakeSpawner(opts = {}) {
  const calls = []
  let failOnce = opts.failOnce ?? 0
  const spawn = async (label, prompt, schema) => {
    calls.push(label)
    if (failOnce > 0 && /分析/.test(label)) { failOnce--; throw new Error('transient') }
    const props = Object.keys(schema.properties)
    if (props.includes('sections')) return { title: 'Fake Title', kind: 'essay', sections: [{ startPid: 'p1', title: '开篇' }, { startPid: 'p7', title: '后半' }] }
    if (props.includes('translations')) {
      const pids = [...prompt.matchAll(/^\[(p\d+)\]/gm)].map((m) => m[1])
      const keep = opts.dropFirstTranslation && !calls.some((c) => /补译/.test(c)) ? pids.slice(1) : pids
      return { translations: keep.map((pid) => ({ pid, zh: `译文${pid}` })) }
    }
    if (props.includes('eli5')) {
      const pid = /^\[(p\d+)\]/m.exec(prompt)[1]
      return { summary: '概括', keyPoints: ['要点1', '要点2'], critique: '点评', eli5: '大白话', highlights: [{ pid: 'p999', quote: 'says something important about theory and practice', why: '核心' }], figures: [{ pid: 'p999', why: '越界被丢' }] }
    }
    if (props.includes('oneLine')) return { oneLine: '一句话', summary: '全文', critique: '全文点评', readingAdvice: '建议' }
    throw new Error('unknown schema')
  }
  return { spawn, calls }
}

async function seedJob(ref, doc, scope = 'all') {
  const d = D.newDigest(doc, 'k')
  const stamp = new Date().toISOString()
  d.job = { id: 'job1', state: 'queued', scope, force: false, sessionId: null, startedAt: stamp, updatedAt: stamp, done: 0, total: 0, message: '', errors: [] }
  await D.writeDigest(ref, d)
}

test('编排：分节 → 分析 + 翻译并发 → 全文总览；结果落盘、引句纠正到正确段落、越界图表被丢', async () => {
  const doc = fakeDoc(12)
  const { ref } = tempPaper(doc)
  await seedJob(ref, doc)
  const { spawn, calls } = fakeSpawner()
  const msg = await R.runDigestJob(ref, 'job1', spawn, { concurrency: 3, heartbeatMs: 50 })
  assert.match(msg, /完成/)
  const d = await D.readDigest(ref)
  assert.equal(d.outline.title, 'Fake Title')
  assert.deepEqual(d.outline.sections.map((s) => [s.start, s.end]), [[1, 6], [7, 12]])
  assert.equal(Object.keys(d.translations).length, 12)
  assert.equal(d.translations.p5, '译文p5')
  const a = d.analyses.s1
  assert.equal(a.highlights.length, 1)
  assert.equal(a.highlights[0].pid, 'p1', 'pid 写错时在本节段落里找回')
  assert.ok(a.highlights[0].range)
  assert.equal(a.figures.length, 0)
  assert.equal(d.overview.oneLine, '一句话')
  assert.equal(d.job.state, 'done')
  assert.equal(d.job.done, d.job.total)
  assert.ok(calls.includes('精读·分节') && calls.includes('精读·全文总览'))
})

test('编排：子代理失败重试一次；翻译漏段补译一次；只生成指定节时不写全文总览', async () => {
  const doc = fakeDoc(12)
  const { ref } = tempPaper(doc)
  await seedJob(ref, doc, ['s2'])
  const { spawn, calls } = fakeSpawner({ failOnce: 1, dropFirstTranslation: true })
  await R.runDigestJob(ref, 'job1', spawn, { concurrency: 2, heartbeatMs: 50 })
  const d = await D.readDigest(ref)
  assert.ok(d.analyses.s2 && !d.analyses.s1, '只分析 s2')
  assert.ok(calls.some((c) => /补译/.test(c)), '漏段触发补译')
  for (let i = 7; i <= 12; i++) assert.ok(d.translations[`p${i}`], `p${i} 有译文`)
  assert.equal(d.overview, null, '不是全部节都分析过 → 不写总览')
  assert.equal(d.job.errors.length, 0, '重试成功不计错误')
})

test('编排：停止请求在派发下一个任务前生效；job id 不匹配直接拒绝', async () => {
  const doc = fakeDoc(40)
  const { ref } = tempPaper(doc)
  await seedJob(ref, doc)
  let n = 0
  const base = fakeSpawner().spawn
  const spawn = async (label, prompt, schema) => {
    if (++n === 3) await D.updateDigest(ref, (x) => { x.job.stopRequested = true })
    return base(label, prompt, schema)
  }
  await R.runDigestJob(ref, 'job1', spawn, { concurrency: 1, heartbeatMs: 50 })
  const d = await D.readDigest(ref)
  assert.equal(d.job.state, 'stopped')
  assert.ok(d.job.done < d.job.total)
  await assert.rejects(() => R.runDigestJob(ref, 'other-job', spawn), /找不到这个精读任务/)
})

test('产物清单：.digest.json 随文献改名/删除（精确 stem）', async () => {
  const M = await load('library-manage.js')
  assert.ok(M.PAPER_STEM_SUFFIXES.includes('.digest.json'))
  assert.ok(M.matchArtifactName('paper', 'paper.digest.json'))
  assert.ok(!M.matchArtifactName('pap', 'paper.digest.json'))
})

test('preset：bundle patch 声明编排 preset（persona + digest-agent 工具）与 worker preset（无工具）；不重复声明宿主层 subagent 服务', () => {
  const patch = readFileSync(join(REPO, 'cordis.patch.yml'), 'utf8')
  const orch = patch.slice(patch.indexOf('id: preset-paper-digest\n'), patch.indexOf('id: preset-paper-digest-worker'))
  const worker = patch.slice(patch.indexOf('id: preset-paper-digest-worker'))
  assert.match(orch, /id: paper-digest\n/)
  assert.match(orch, /@ggboy123\/dsh-paper-reader\/digest-agent/)
  assert.ok(!/dsh-subagent/.test(patch.replace(/^\s*#.*$/gm, '')), 'subagent 服务在宿主层，preset 里不得重复挂')
  assert.match(worker, /id: paper-digest-worker\n/)
  assert.ok(!/digest-agent|dsh-tool-/.test(worker), 'worker 不得带工具')
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./digest-agent'], './dist/digest-agent.js')
})
