// digest.ts — 精读（逐段翻译 / 分节概括·总结·点评 / 高中生版讲解 / 重点句与图）的数据模型与规划。
// 纯函数模块，不依赖 Cordis：读写 <文献>.digest.json、切分任务、构造 subagent 提示词与输出 schema、
// 把模型给出的「原文引句」定位回段落字符区间（阅读器据此画高亮）。
//
// 一次生成 = 一个编排会话调用 digest_generate 工具（src/digest-agent.ts），工具按本模块规划的任务
// 并行派发 subagent；每完成一个任务就写回 .digest.json，阅读器轮询读取，边生成边可看。

import { readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { PaperRef } from './library.ts'
import type { DigestDoc, Paragraph } from './digest-extract.ts'

export const DIGEST_VERSION = 1

export interface Section {
  id: string
  title: string
  /** 区间端点（含）：段落 id 序号 */
  start: number
  end: number
}

export interface Highlight {
  pid: string
  quote: string
  why: string
  /** 在段落 text 里的字符区间；定位失败为 null（面板照常展示引句，只是不画高亮） */
  range: [number, number] | null
}

export interface SectionAnalysis {
  summary: string
  keyPoints: string[]
  critique: string
  eli5: string
  highlights: Highlight[]
  figures: Array<{ pid: string; why: string }>
}

export interface Overview {
  oneLine: string
  summary: string
  critique: string
  readingAdvice: string
}

export type JobState = 'queued' | 'running' | 'done' | 'error' | 'stopped'

export interface DigestJob {
  id: string
  state: JobState
  /** 'all' 或 section id 列表 */
  scope: 'all' | string[]
  force: boolean
  sessionId: string | null
  startedAt: string
  updatedAt: string
  done: number
  total: number
  message: string
  errors: string[]
  stopRequested?: boolean
}

export interface DigestFile {
  version: number
  /** PDF 的 size+mtime：PDF 换了就整体作废 */
  pdfKey: string
  doc: DigestDoc
  /** 源语言是否需要翻译（正文主要是中文时为 false） */
  needsTranslation: boolean
  outline: { title: string; kind: string; sections: Section[]; source: 'model' | 'heuristic' } | null
  analyses: Record<string, SectionAnalysis>
  translations: Record<string, string>
  overview: Overview | null
  job: DigestJob | null
}

export const digestPathFor = (ref: PaperRef) => ref.pdfPath.replace(/\.pdf$/i, '') + '.digest.json'

const pnum = (pid: string) => +pid.slice(1)

export async function readDigest(ref: PaperRef): Promise<DigestFile | null> {
  try {
    const v = JSON.parse(await readFile(digestPathFor(ref), 'utf8')) as DigestFile
    return v?.version === DIGEST_VERSION ? v : null
  } catch {
    return null
  }
}

export async function writeDigest(ref: PaperRef, d: DigestFile): Promise<void> {
  const path = digestPathFor(ref)
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  await writeFile(tmp, JSON.stringify(d))
  await rename(tmp, path)
}

/**
 * 同一文件的读改写串行化（同进程内）。生成任务并发完成时都要往同一个 .digest.json 合并结果，
 * 不串行会互相覆盖。键是文件路径；进程重启后自然清空。
 */
const chains = new Map<string, Promise<unknown>>()
export function updateDigest<T>(ref: PaperRef, fn: (d: DigestFile) => T | Promise<T>): Promise<T> {
  const key = digestPathFor(ref)
  const run = async () => {
    const d = await readDigest(ref)
    if (!d) throw new Error('精读数据不存在或已失效，请重新生成')
    const out = await fn(d)
    await writeDigest(ref, d)
    return out
  }
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(run, run)
  chains.set(key, next.catch(() => {}))
  return next
}

/** CJK 字符占比高 → 原文就是中文，跳过翻译。 */
export function detectNeedsTranslation(doc: DigestDoc): boolean {
  const sample = doc.paragraphs.slice(0, 200).map((p) => p.text).join('')
  if (!sample) return false
  const cjk = (sample.match(/[㐀-鿿]/g) ?? []).length
  return cjk / sample.length < 0.3
}

const wordCount = (s: string) => {
  const cjk = (s.match(/[㐀-鿿]/g) ?? []).length
  const words = s.replace(/[㐀-鿿]/g, ' ').split(/\s+/).filter(Boolean).length
  return words + Math.ceil(cjk / 1.6)
}

// ── 分节 ──────────────────────────────────────────────────────────────

/**
 * 启发式分节（outline 子代理失败或文档太短时的兜底）：
 * 以 heading 段落为界；文首连续的 heading（标题/作者）归入第一节；
 * 没有任何 heading 时按约 2500 词切块。
 */
export function heuristicSections(paras: Paragraph[]): Section[] {
  const n = paras.length
  if (!n) return []
  const starts: number[] = []
  let leading = true
  for (let i = 0; i < n; i++) {
    const p = paras[i]!
    if (p.kind === 'heading') {
      if (leading) continue
      // 连续 heading 只在第一条处断开
      if (paras[i - 1]?.kind !== 'heading') starts.push(i)
    } else {
      leading = false
    }
  }
  let bounds = [0, ...starts.filter((s) => s > 0)]
  if (bounds.length === 1) {
    bounds = [0]
    let acc = 0
    for (let i = 0; i < n; i++) {
      acc += wordCount(paras[i]!.text)
      if (acc > 2500 && i + 1 < n) { bounds.push(i + 1); acc = 0 }
    }
  }
  return boundsToSections(paras, bounds, (i) => {
    const h = paras[i]!
    return h.kind === 'heading' ? h.text.slice(0, 60) : `第 ${i === 0 ? 1 : bounds.indexOf(i) + 1} 部分`
  })
}

function boundsToSections(paras: Paragraph[], bounds: number[], titleAt: (i: number) => string): Section[] {
  const out: Section[] = []
  const uniq = [...new Set(bounds)].sort((a, b) => a - b)
  for (let k = 0; k < uniq.length; k++) {
    const s = uniq[k]!
    const e = (uniq[k + 1] ?? paras.length) - 1
    if (e < s) continue
    out.push({ id: `s${out.length + 1}`, title: titleAt(s), start: pnum(paras[s]!.id), end: pnum(paras[e]!.id) })
  }
  return out
}

/** outline 子代理结果 → Section[]：校验 start 段落存在且递增，首节强制从第一段开始，覆盖全部段落。 */
export function sectionsFromOutline(paras: Paragraph[], items: Array<{ startPid: string; title: string }>): Section[] {
  const index = new Map(paras.map((p, i) => [p.id, i]))
  const picked: Array<{ i: number; title: string }> = []
  for (const it of items) {
    const i = index.get(String(it.startPid).trim())
    if (i === undefined) continue
    if (picked.length && i <= picked[picked.length - 1]!.i) continue
    picked.push({ i, title: String(it.title || '').trim().slice(0, 80) || '（无标题）' })
  }
  if (!picked.length) return []
  picked[0]!.i = 0
  const titles = new Map(picked.map((p) => [p.i, p.title]))
  return boundsToSections(paras, picked.map((p) => p.i), (i) => titles.get(i) ?? '')
}

export const sectionParas = (doc: DigestDoc, s: Section) => doc.paragraphs.filter((p) => pnum(p.id) >= s.start && pnum(p.id) <= s.end)

// ── 任务规划 ──────────────────────────────────────────────────────────

export type Task =
  | { kind: 'analyze'; sectionId: string; part: number; parts: number; pids: string[] }
  | { kind: 'translate'; sectionId: string; pids: string[] }
  | { kind: 'overview' }

/** 单次翻译的词数上限：输出约为输入的 1.5~2 倍字符，留足 structured_output 的余量。 */
export const TRANSLATE_CHUNK_WORDS = 1100
/** 单次分析的词数上限：超长章节（整本书的一章）切成多段分别分析，再由面板按段展示。 */
export const ANALYZE_MAX_WORDS = 28000

export function planTasks(d: DigestFile, sectionIds: string[], force: boolean): Task[] {
  const tasks: Task[] = []
  if (!d.outline) return tasks
  for (const s of d.outline.sections) {
    if (!sectionIds.includes(s.id)) continue
    const paras = sectionParas(d.doc, s)
    // 分析：整节一次；超长切段
    if (force || !d.analyses[s.id]) {
      const parts: string[][] = [[]]
      let acc = 0
      for (const p of paras) {
        const w = wordCount(p.text)
        if (acc + w > ANALYZE_MAX_WORDS && parts[parts.length - 1]!.length) { parts.push([]); acc = 0 }
        parts[parts.length - 1]!.push(p.id)
        acc += w
      }
      parts.forEach((pids, k) => tasks.push({ kind: 'analyze', sectionId: s.id, part: k + 1, parts: parts.length, pids }))
    }
    // 翻译：按块，已有译文的段落跳过（force 时全重翻）
    if (d.needsTranslation) {
      let chunk: string[] = []
      let acc = 0
      const flush = () => { if (chunk.length) tasks.push({ kind: 'translate', sectionId: s.id, pids: chunk }); chunk = []; acc = 0 }
      for (const p of paras) {
        if (!force && d.translations[p.id]) continue
        const w = wordCount(p.text)
        if (acc + w > TRANSLATE_CHUNK_WORDS && chunk.length) flush()
        chunk.push(p.id)
        acc += w
      }
      flush()
    }
  }
  return tasks
}

// ── subagent 提示词与输出 schema ────────────────────────────────────────

/** 段落清单。withPage=false 用于翻译：页码标记会被模型当成正文抄进译文。 */
const paraLines = (doc: DigestDoc, pids: string[], withPage = true) => {
  const byId = new Map(doc.paragraphs.map((p) => [p.id, p]))
  return pids.map((id) => {
    const p = byId.get(id)!
    const tag = p.kind === 'body' ? '' : `（${({ heading: '标题', caption: '图表说明', note: '注释', figure: '图表' } as Record<string, string>)[p.kind] ?? p.kind}）`
    const where = withPage ? `<${p.label ? `p.${p.label}` : `PDF 第 ${p.page} 页`}> ` : ''
    return `[${p.id}] ${tag}${where}${p.text}`
  }).join('\n\n')
}

const OCR_NOTE = '原文可能来自扫描件 OCR：会有个别错字、断词、多余标点或乱码。理解时按上下文自动纠正，不要在输出里讨论这些识别错误。'

export function outlinePrompt(d: DigestFile): string {
  const paras = d.doc.paragraphs
  // 预算：总预览约 60k 字符；段落太多时只给每段开头若干字，heading 段落总是给全
  const per = Math.max(24, Math.min(160, Math.floor(60000 / Math.max(1, paras.length))))
  const lines = paras.map((p) => {
    const where = p.label ? `p.${p.label}` : `PDF${p.page}`
    const kind = p.kind === 'heading' ? '【标题候选】' : p.kind === 'caption' ? '【图表说明】' : ''
    const text = p.kind === 'heading' ? p.text.slice(0, 120) : p.text.slice(0, per)
    return `[${p.id}] ${where} ${kind}${text}`
  })
  return [
    '任务：为下面这篇文献划分「大节」（top-level sections），供后续逐节精读。',
    '',
    '要求：',
    '- 识别文献类型（paper=论文 / essay=文章 / book=书或书的章节 / other）和标题。',
    '- 大节是读者理解全文的一级结构单元：论文按 Introduction / Method / Results … 这一级；书按章；只有罗马数字小节号的文章按 I / II / III …。',
    '- 文首的标题、作者、题记（epigraph）、摘要归入第一节，不要单独成节。',
    '- 每节给出它的起始段落 id（startPid，必须是下面出现过的 id，按顺序递增）和一个简短的中文标题（原文有标题就译出来，没有就概括本节主题，8~20 字）。',
    '- 节数适中：短文 3~8 节，长论文 5~12 节，书按章（每节可以很长）。不要把每个段落都切成一节。',
    '- 【标题候选】是自动识别的，可能有误（如引诗、列表项被误识别），以内容为准。',
    `- ${OCR_NOTE}`,
    '',
    `段落列表（每段只给开头 ${per} 字）：`,
    lines.join('\n'),
  ].join('\n')
}

export const OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '文献标题（原文）' },
    kind: { type: 'string', enum: ['paper', 'essay', 'book', 'other'] },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startPid: { type: 'string', description: '本节起始段落 id，如 p12' },
          title: { type: 'string', description: '中文节标题' },
        },
        required: ['startPid', 'title'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'kind', 'sections'],
  additionalProperties: false,
} as const

export function translatePrompt(d: DigestFile, task: Extract<Task, { kind: 'translate' }>): string {
  const s = d.outline!.sections.find((x) => x.id === task.sectionId)!
  return [
    `任务：把下面的段落逐段翻译成简体中文。文献：《${d.outline!.title}》，所在章节：「${s.title}」。`,
    '',
    '要求：',
    '- 每个段落 id 输出一条译文，id 原样照抄，不合并、不拆分、不遗漏。',
    '- 忠实、通顺，学术语气；不加评论、不加译者注。',
    '- 专有名词、关键术语首次出现时在中文后括注原文，如「范式（paradigm）」。人名可保留原文。',
    '- 标题类段落译成简短标题；引文、诗句照原意译；脚注号、文献引用保持原样。',
    `- ${OCR_NOTE}`,
    '',
    '段落（方括号里是段落 id，不属于正文，不要译出）：',
    paraLines(d.doc, task.pids, false),
  ].join('\n')
}

export const TRANSLATE_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { pid: { type: 'string' }, zh: { type: 'string' } },
        required: ['pid', 'zh'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
} as const

export function analyzePrompt(d: DigestFile, task: Extract<Task, { kind: 'analyze' }>): string {
  const o = d.outline!
  const s = o.sections.find((x) => x.id === task.sectionId)!
  const toc = o.sections.map((x) => `${x.id === s.id ? '→ ' : '   '}${x.title}`).join('\n')
  const part = task.parts > 1 ? `（本节较长，这是第 ${task.part}/${task.parts} 部分，只分析这一部分）` : ''
  const hasFigures = task.pids.some((id) => {
    const p = d.doc.paragraphs.find((x) => x.id === id)
    return p?.kind === 'caption' || p?.kind === 'figure'
  })
  return [
    `任务：精读《${o.title}》的一节，并为中文读者写出分析。当前节：「${s.title}」${part}`,
    '',
    '全文结构（→ 为当前节）：',
    toc,
    '',
    '请输出（全部用简体中文）：',
    '1. summary —— 概括：2~4 句话说清本节在讲什么、在全文论证中起什么作用。',
    '2. keyPoints —— 总结：3~6 条要点，每条一句，覆盖本节的主要论点、证据与结论。',
    '3. critique —— 批判点评：150~350 字。指出本节论证的长处，以及隐含前提、论证跳跃、证据不足、可能的反例或反方观点；要具体，引用本节内容，不说空话。',
    '4. eli5 —— 高中生版讲解：200~400 字。假设读者是聪明的高中生、没有专业背景：先用一句大白话说清核心意思，再用生活中的类比或例子解释，遇到术语当场用一句话解释。不要堆砌术语，不要居高临下。',
    '5. highlights —— 重点句：2~6 条本节最重要的原句。quote 必须从段落原文中**逐字复制**（保持原文语言，不翻译，不改动标点，长度 8~40 个词），pid 写它所在的段落 id；why 用一句中文说明为什么重要。',
    hasFigures
      ? '6. figures —— 重要图表：本节中对理解最关键的图表（只能从标注为（图表说明）/（图表）的段落里选，给 pid 和一句中文理由）；没有就给空数组。'
      : '6. figures —— 本节没有图表说明段落，给空数组。',
    `- ${OCR_NOTE}`,
    '',
    '本节段落：',
    paraLines(d.doc, task.pids),
  ].join('\n')
}

export const ANALYZE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    keyPoints: { type: 'array', items: { type: 'string' } },
    critique: { type: 'string' },
    eli5: { type: 'string' },
    highlights: {
      type: 'array',
      items: {
        type: 'object',
        properties: { pid: { type: 'string' }, quote: { type: 'string' }, why: { type: 'string' } },
        required: ['pid', 'quote', 'why'],
        additionalProperties: false,
      },
    },
    figures: {
      type: 'array',
      items: {
        type: 'object',
        properties: { pid: { type: 'string' }, why: { type: 'string' } },
        required: ['pid', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'keyPoints', 'critique', 'eli5', 'highlights', 'figures'],
  additionalProperties: false,
} as const

export function overviewPrompt(d: DigestFile): string {
  const o = d.outline!
  const body = o.sections.map((s) => {
    const a = d.analyses[s.id]
    return a ? `## ${s.title}\n概括：${a.summary}\n要点：\n${a.keyPoints.map((k) => `- ${k}`).join('\n')}` : `## ${s.title}\n（本节未分析）`
  }).join('\n\n')
  return [
    `任务：根据各节的分析，为《${o.title}》写全文总览（简体中文）。`,
    '',
    '输出：',
    '- oneLine：一句话说清全文的核心主张（不超过 50 字）。',
    '- summary：全文概要，200~350 字，讲清问题、论证路线与结论。',
    '- critique：全文层面的批判点评，150~300 字：贡献、局限、值得追问的地方。',
    '- readingAdvice：给读者的阅读建议，2~4 句：哪几节最值得精读、读之前需要什么背景。',
    '',
    body,
  ].join('\n')
}

export const OVERVIEW_SCHEMA = {
  type: 'object',
  properties: {
    oneLine: { type: 'string' },
    summary: { type: 'string' },
    critique: { type: 'string' },
    readingAdvice: { type: 'string' },
  },
  required: ['oneLine', 'summary', 'critique', 'readingAdvice'],
  additionalProperties: false,
} as const

// ── 引句定位 ──────────────────────────────────────────────────────────

/** 归一化：小写、统一引号与破折号、去掉非字母数字（保留映射回原文下标的表）。 */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = ''
  const map: number[] = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!.toLowerCase()
    if (/[\p{L}\p{N}]/u.test(ch)) {
      norm += ch
      map.push(i)
    }
  }
  return { norm, map }
}

/**
 * 在段落里定位模型给出的引句，返回原文字符区间。
 * 1) 归一化后精确子串；2) 不行则按「最长公共连续片段」锚定：取引句首尾各一段做锚点，
 *    两个锚点都命中且顺序正确、跨度合理才认（避免把高亮画到无关位置）。OCR 错字、连字符断词都能扛。
 */
export function locateQuote(text: string, quote: string): [number, number] | null {
  const t = normalizeWithMap(text)
  const q = normalizeWithMap(quote).norm
  if (q.length < 6) return null
  const exact = t.norm.indexOf(q)
  if (exact >= 0) return [t.map[exact]!, t.map[exact + q.length - 1]! + 1]
  const anchor = Math.min(24, Math.floor(q.length / 3))
  const findAnchor = (needle: string, from: number) => t.norm.indexOf(needle, from)
  for (let shrink = 0; shrink <= 2; shrink++) {
    const len = Math.max(8, anchor - shrink * 6)
    for (let off = 0; off + len <= Math.min(q.length, 40); off += 4) {
      const head = q.slice(off, off + len)
      const hi = findAnchor(head, 0)
      if (hi < 0) continue
      for (let toff = 0; toff + len <= Math.min(q.length, 40); toff += 4) {
        const tail = q.slice(q.length - len - toff, q.length - toff)
        const ti = findAnchor(tail, hi + len)
        if (ti < 0) continue
        const startN = Math.max(0, hi - off)
        const endN = Math.min(t.norm.length, ti + len + toff)
        const span = endN - startN
        if (span < q.length * 0.7 || span > q.length * 1.4) continue
        return [t.map[startN]!, t.map[endN - 1]! + 1]
      }
    }
  }
  return null
}

/** 把分析结果规整后写进 digest：pid 必须属于本次任务的段落，引句定位到字符区间。多段分析时合并。 */
export function mergeAnalysis(d: DigestFile, task: Extract<Task, { kind: 'analyze' }>, raw: unknown): void {
  const r = raw as Partial<SectionAnalysis> & { highlights?: Array<{ pid?: string; quote?: string; why?: string }> }
  const allowed = new Set(task.pids)
  const byId = new Map(d.doc.paragraphs.map((p) => [p.id, p]))
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const highlights: Highlight[] = []
  for (const h of r.highlights ?? []) {
    const quote = str(h.quote)
    if (!quote) continue
    let pid = str(h.pid)
    let range: [number, number] | null = null
    const p = byId.get(pid)
    if (p && allowed.has(pid)) range = locateQuote(p.text, quote)
    if (!range) {
      // 模型 pid 写错是常态：在本节所有段落里找一遍
      for (const id of task.pids) {
        const rr = locateQuote(byId.get(id)!.text, quote)
        if (rr) { pid = id; range = rr; break }
      }
    }
    if (!allowed.has(pid)) pid = task.pids[0]!
    highlights.push({ pid, quote, why: str(h.why), range })
  }
  const figures = (r.figures ?? [])
    .map((f) => ({ pid: str(f?.pid), why: str(f?.why) }))
    .filter((f) => allowed.has(f.pid))
  const next: SectionAnalysis = {
    summary: str(r.summary),
    keyPoints: (r.keyPoints ?? []).map(str).filter(Boolean),
    critique: str(r.critique),
    eli5: str(r.eli5),
    highlights,
    figures,
  }
  const prev = task.part > 1 ? d.analyses[task.sectionId] : undefined
  if (prev && task.parts > 1) {
    const join = (a: string, b: string) => [a, b].filter(Boolean).join(`\n\n【第 ${task.part} 部分】`)
    d.analyses[task.sectionId] = {
      summary: join(prev.summary, next.summary),
      keyPoints: [...prev.keyPoints, ...next.keyPoints],
      critique: join(prev.critique, next.critique),
      eli5: join(prev.eli5, next.eli5),
      highlights: [...prev.highlights, ...next.highlights],
      figures: [...prev.figures, ...next.figures],
    }
  } else {
    d.analyses[task.sectionId] = next
  }
}

/** 合并译文；返回缺失的 pid（调用方据此重试一次）。 */
export function mergeTranslations(d: DigestFile, task: Extract<Task, { kind: 'translate' }>, raw: unknown): string[] {
  const allowed = new Set(task.pids)
  const items = (raw as { translations?: Array<{ pid?: unknown; zh?: unknown }> })?.translations ?? []
  for (const it of items) {
    const pid = typeof it.pid === 'string' ? it.pid.trim() : ''
    // 兜底：模型偶尔把提示词里的段落 id / 位置标记抄进译文开头
    const zh = typeof it.zh === 'string' ? it.zh.trim().replace(/^(\[p\d+\]\s*)?(<(p\.[^>]{1,12}|PDF 第 \d+ 页)>\s*)?/, '') : ''
    if (allowed.has(pid) && zh) d.translations[pid] = zh
  }
  return task.pids.filter((id) => !d.translations[id])
}

export function mergeOverview(d: DigestFile, raw: unknown): void {
  const r = raw as Partial<Overview>
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  d.overview = { oneLine: str(r.oneLine), summary: str(r.summary), critique: str(r.critique), readingAdvice: str(r.readingAdvice) }
}

/** 新建 digest（抽取结果 + 空结果）。 */
export function newDigest(doc: DigestDoc, pdfKey: string): DigestFile {
  return {
    version: DIGEST_VERSION,
    pdfKey,
    doc,
    needsTranslation: detectNeedsTranslation(doc),
    outline: null,
    analyses: {},
    translations: {},
    overview: null,
    job: null,
  }
}

/** 运行中的任务心跳超过这个时长没更新，视为已中断（进程重启/会话被关）。 */
export const STALE_JOB_MS = 3 * 60_000

export function jobIsLive(job: DigestJob | null, now = Date.now()): boolean {
  if (!job || (job.state !== 'queued' && job.state !== 'running')) return false
  return now - Date.parse(job.updatedAt) < STALE_JOB_MS
}
