// digest-extract.ts — 精读的结构化抽取（纯函数，不依赖 Cordis）。
//
// 产出「段落 + 行级坐标」，供精读的逐段翻译、分节、重点句高亮共用。两条来源：
//  1. pdf.js 文本层：文字型 PDF 与「扫描图 + 隐形 OCR 层」的扫描书都走这里。
//     扫描书常见形态都要扛住：一张 PDF 页 = 左右两页书（跨页）、页眉页码、行尾断词、
//     轻微倾斜（行首 x 随 y 漂移）、只有罗马数字的小节标记。
//  2. MinerU content_list：没有文本层的纯图片扫描件（OCR 后只有块级 bbox，句级高亮退化为块级）。
//
// 坐标一律是 PDF 用户空间（y 向上，与 page.getViewport({scale:1}) 同一套），
// 阅读器用 viewport.convertToViewportRectangle 换算到屏幕，缩放/翻页无关。

import { readFile } from 'node:fs/promises'

/** 段落里一段连续文字的位置：[start, end, pdfPage, x, y, w, h]（text 的 [start,end) 落在这个矩形里）。 */
export type Span = [number, number, number, number, number, number, number]

export type ParagraphKind = 'body' | 'heading' | 'caption' | 'note' | 'figure'

export interface Paragraph {
  id: string
  kind: ParagraphKind
  /** 首行所在 PDF 页（1 起） */
  page: number
  /** 首行所在的书页页码（取自页眉/页脚；取不到为 null） */
  label: string | null
  text: string
  spans: Span[]
}

export interface DigestDoc {
  source: 'pdfjs' | 'mineru'
  pageCount: number
  /** 每张 PDF 页的尺寸（用户空间） */
  pageSizes: Array<[number, number]>
  paragraphs: Paragraph[]
  /** 抽取过程中的如实提示（跨页拆分、页眉剔除数量等） */
  notes: string[]
}

// ── pdf.js 文本层 → 纯数据（便于单测：核心算法只吃这份结构） ────────────────

export interface RawItem {
  str: string
  /** 基线起点（用户空间） */
  x: number
  y: number
  w: number
  /** 字高（用户空间，取自 transform 的纵向缩放） */
  h: number
  eol: boolean
}

export interface RawPage {
  page: number
  width: number
  height: number
  items: RawItem[]
}

interface Line {
  page: number
  text: string
  /** 行内每个 item 在 text 里的区间与矩形 */
  pieces: Array<{ s: number; e: number; x: number; y: number; w: number; h: number }>
  x0: number
  x1: number
  y: number
  h: number
}

interface Region {
  page: number
  /** 区域水平范围（跨页拆分后的左/右半页） */
  x0: number
  x1: number
  /** 是否为跨页里的一页书（决定页码标签各自独立） */
  logical: boolean
  lines: Line[]
  label: string | null
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

const LETTERS = /\p{L}/gu
const letterCount = (s: string) => (s.match(LETTERS) ?? []).length

/** 把一页的 item 流拼成行：遇 hasEOL、基线跳变或 x 明显回退就断行。 */
export function buildLines(p: RawPage): Line[] {
  const lines: Line[] = []
  let cur: Line | null = null
  const flush = () => {
    if (cur && cur.text.trim()) {
      // 去掉行首行尾空白，同时平移 pieces 的区间
      const lead = cur.text.length - cur.text.trimStart().length
      const text = cur.text.trim()
      cur.pieces = cur.pieces
        .map((pc) => ({ ...pc, s: Math.max(0, pc.s - lead), e: Math.min(text.length, pc.e - lead) }))
        .filter((pc) => pc.e > pc.s)
      cur.text = text
      // 行基线/字高取「按字数加权的中位数」：首字下沉的大号字母只占一个字，不该决定整行的位置与字号
      const weighted: Array<[number, number, number]> = cur.pieces.map((pc) => [pc.y, pc.h, pc.e - pc.s])
      const wmed = (k: 0 | 1) => {
        const s = [...weighted].sort((a, b) => a[k] - b[k])
        const total = s.reduce((t, w) => t + w[2], 0)
        let acc = 0
        for (const w of s) { acc += w[2]; if (acc * 2 >= total) return w[k] }
        return s[s.length - 1]?.[k] ?? 0
      }
      if (weighted.length) { cur.y = wmed(0); cur.h = wmed(1) }
      // 首字下沉 "T hose" → "Those"：OCR 层自带的空格 item 把大号首字母与后文隔开了
      const first = cur.pieces[0]
      if (first && cur.text.slice(first.s, first.e).trim().length === 1 && /^\p{Lu} \p{Ll}/u.test(cur.text) && first.h > 1.5 * cur.h) {
        cur.text = cur.text[0] + cur.text.slice(2)
        cur.pieces = cur.pieces.map((pc, k) => (k === 0 ? { ...pc, e: 1 } : { ...pc, s: Math.max(1, pc.s - 1), e: pc.e - 1 }))
      }
      lines.push(cur)
    }
    cur = null
  }
  for (const it of p.items) {
    const str = it.str.replace(/\s+/g, ' ')
    if (!str) {
      if (it.eol) flush()
      continue
    }
    const h = Math.max(it.h, 1)
    if (cur) {
      const jump = Math.abs(it.y - cur.y) > 0.6 * Math.max(h, cur.h)
      const back = it.x < cur.x1 - 2 * Math.max(h, cur.h)
      if (jump || back) flush()
    }
    if (!cur) cur = { page: p.page, text: '', pieces: [], x0: it.x, x1: it.x + it.w, y: it.y, h }
    // item 之间有明显空隙而两侧都没有空格：补一个空格（OCR 层常把每个词拆成独立 item）
    // 例外：首字下沉（一个大号大写字母 + 正常字号的后续）不补空格，免得 "T hose"
    const dropCap = /^\p{Lu}$/u.test(cur?.text ?? '') && (cur?.pieces[0]?.h ?? 0) > 1.5 * h
    if (cur && cur.text && !dropCap && !/\s$/.test(cur.text) && !/^\s/.test(str) && it.x - cur.x1 > 0.18 * h) cur.text += ' '
    const s = cur.text.length
    cur.text += str
    if (str.trim()) cur.pieces.push({ s, e: cur.text.length, x: it.x, y: it.y, w: Math.max(it.w, 0.5), h })
    cur.x0 = Math.min(cur.x0, it.x)
    cur.x1 = Math.max(cur.x1, it.x + it.w)
    cur.h = Math.max(cur.h, h)
    if (it.eol) flush()
  }
  flush()
  return lines
}

/**
 * 找竖直分栏线：在 [lo, hi] 里扫描候选 x，取被行横穿最少的位置。
 * 横穿比例足够低、两侧都有足量的行，才认定为分栏（跨页的书脊 / 双栏论文的栏缝）。
 */
function findSplit(lines: Line[], width: number, lo: number, hi: number, maxCross: number, minSide: number): number | null {
  if (lines.length < 6) return null
  let best: { x: number; cross: number } | null = null
  const step = width / 200
  for (let x = width * lo; x <= width * hi; x += step) {
    let cross = 0
    for (const l of lines) if (l.x0 < x - 1 && l.x1 > x + 1) cross++
    if (!best || cross < best.cross) best = { x, cross }
  }
  if (!best || best.cross > lines.length * maxCross) return null
  const left = lines.filter((l) => (l.x0 + l.x1) / 2 < best!.x).length
  const right = lines.length - left
  if (left < lines.length * minSide || right < lines.length * minSide) return null
  return best.x
}

/** 一张 PDF 页 → 阅读序的区域（跨页 = 左右两页书；竖版双栏 = 同一页的两栏；否则整页一个区域）。 */
export function pageRegions(p: RawPage, lines: Line[]): Region[] {
  const spread = p.width > p.height * 1.15
  const split = spread
    ? findSplit(lines, p.width, 0.35, 0.65, 0.05, 0.15)
    : findSplit(lines, p.width, 0.4, 0.6, 0.02, 0.25)
  const sortTopDown = (ls: Line[]) => [...ls].sort((a, b) => (b.y - a.y) || (a.x0 - b.x0))
  if (split === null) return [{ page: p.page, x0: 0, x1: p.width, logical: false, lines: sortTopDown(lines), label: null }]
  const left = lines.filter((l) => (l.x0 + l.x1) / 2 < split)
  const right = lines.filter((l) => (l.x0 + l.x1) / 2 >= split)
  return [
    { page: p.page, x0: 0, x1: split, logical: spread, lines: sortTopDown(left), label: null },
    { page: p.page, x0: split, x1: p.width, logical: spread, lines: sortTopDown(right), label: null },
  ]
}

const HEADER_NUM = /^(\d{1,4})\s+\S.*$|^.*\S\s+(\d{1,4})$/
const ONLY_NUM = /^[\s\-–—.]*(\d{1,4})[\s\-–—.]*$/

/** 去掉行里所有非字母（页眉跨页比对用：页码、标点都不算）。 */
const normHead = (s: string) => s.replace(/[^\p{L}]/gu, '').toLowerCase()

/**
 * 页眉/页码/OCR 噪声剔除，同时抽取书页页码标签。
 * 规则只看区域的首尾行：首行是「页码 + 短标题」或在 ≥3 个区域首行重复出现 → 页眉；
 * 尾行是纯数字 → 页脚页码；全篇任何位置的「无字母短串」（如 OCR 的 "...."、"-"）→ 噪声。
 */
export function stripRunningHeads(regions: Region[]): { removed: number } {
  let removed = 0
  const headCount = new Map<string, number>()
  for (const r of regions) {
    const first = r.lines[0]
    if (first) headCount.set(normHead(first.text), (headCount.get(normHead(first.text)) ?? 0) + 1)
  }
  for (const r of regions) {
    // 噪声：字母少于 2 个、且整行很短（保留罗马数字小节标记 "II" 这类：它们有字母）
    const before = r.lines.length
    r.lines = r.lines.filter((l) => !(letterCount(l.text) < 1 && !ONLY_NUM.test(l.text) && l.text.length <= 8))
    removed += before - r.lines.length
    if (!r.lines.length) continue
    const top = r.lines[0]!
    const yTop = Math.max(...r.lines.map((l) => l.y))
    const words = top.text.split(/\s+/).length
    const m = HEADER_NUM.exec(top.text)
    const repeated = (headCount.get(normHead(top.text)) ?? 0) >= 3 && normHead(top.text).length > 0
    if (top.y >= yTop - 1 && words <= 10 && (m || repeated || ONLY_NUM.test(top.text))) {
      const num = m ? (m[1] ?? m[2]) : ONLY_NUM.exec(top.text)?.[1]
      if (num) r.label = num
      r.lines.shift()
      removed++
    }
    const last = r.lines[r.lines.length - 1]
    if (last && ONLY_NUM.test(last.text)) {
      r.label ??= ONLY_NUM.exec(last.text)![1]!
      r.lines.pop()
      removed++
    }
  }
  // 页码标签补洞：相邻区域的页码通常连续，按前后邻居 ±k 推断（推不出就留 null）
  for (let i = 0; i < regions.length; i++) {
    if (regions[i]!.label !== null) continue
    for (let k = 1; k < 4; k++) {
      const prev = regions[i - k]?.label
      if (prev && /^\d+$/.test(prev)) { regions[i]!.label = String(+prev + k); break }
      const next = regions[i + k]?.label
      if (next && /^\d+$/.test(next) && +next - k > 0) { regions[i]!.label = String(+next - k); break }
    }
  }
  return { removed }
}

const SENT_END = /[.!?:;。！？：；]["'”’)\]]*$/
const CAPTION = /^(fig(ure)?\.?|table|plate|图|表)\s*[\dIVXivx]+/i
// 小节编号独占一行：罗马数字只认 I~XXXIX（单个 L/C 多半是图里的字母，不是 50/100）；或 1、2.3 这类数字编号
const ROMAN_OR_NUM = /^(?:(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3})|\d{1,2}(?:\.\d{1,2})*)\.?$/

/**
 * 区域里的行 → 段落。断段依据（任一成立）：
 *  - 首行缩进：行首比相邻行（上一行/下一行）的行首靠右 0.9~8 个字高（对倾斜扫描稳：只比邻居，不比全局左边距）；
 *  - 行距跳变：与上一行的基线间距 > 1.6 × 本区域行距中位数；
 *  - 上一行是短行且以句末标点收尾；
 *  - 标题行：短、居中（或罗马数字/编号），独立成段；
 *  - 字号明显变小（脚注区）。
 */
interface Draft {
  kind: ParagraphKind
  lines: Line[]
  label: string | null
}

export function regionParagraphs(r: Region): Draft[] {
  const out: Draft[] = []
  const ls = r.lines
  if (!ls.length) return out
  const gaps: number[] = []
  for (let i = 1; i < ls.length; i++) gaps.push(ls[i - 1]!.y - ls[i]!.y)
  const lineGap = median(gaps.filter((g) => g > 0)) || median(ls.map((l) => l.h)) * 1.2
  // 正文字号 = 按字数加权的中位字号：大图里的小字标注行数可能比正文还多，按行取中位会把正文字号拉低，
  // 结果所有短的正文行都被当成「大号字标题」
  const bodyH = (() => {
    const w = ls.map((l) => [l.h, l.text.length] as const).sort((a, b) => a[0] - b[0])
    const total = w.reduce((t, x) => t + x[1], 0)
    let acc = 0
    for (const [h, n] of w) { acc += n; if (acc * 2 >= total) return h }
    return median(ls.map((l) => l.h))
  })()
  const width = r.x1 - r.x0
  const bodyRight = median(ls.map((l) => l.x1))
  const center = median(ls.map((l) => (l.x0 + l.x1) / 2))

  let cur: Draft | null = null
  const push = (kind: ParagraphKind, l: Line): Draft => {
    const d: Draft = { kind, lines: [l], label: r.label }
    out.push(d)
    return d
  }
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]!
    const prev = ls[i - 1]
    const next = ls[i + 1]
    const t = l.text.trim()
    const short = l.x1 - l.x0 < width * 0.45
    const big = bodyH > 0 && l.h >= bodyH * 1.25
    // 正文中间孤立的小号数字：OCR 碎片或脚注号，不是标题（大号的才可能是章号）
    if (/^\d{1,3}$/.test(t) && !big) continue
    const centered = Math.abs((l.x0 + l.x1) / 2 - center) < width * 0.08 && l.x0 - r.x0 > width * 0.15
    const letters = t.replace(/[^\p{L}]/gu, '')
    const upperRatio = letters ? letters.replace(/[^\p{Lu}]/gu, '').length / letters.length : 0
    const gapBefore = prev ? prev.y - l.y > lineGap * 1.3 : true
    // 「2 Related Work」「3.1 Method」：编号 + 短标题，标题部分不含句读与括号（排除「2. Proof by actual trial. (…)」这类编号列表）
    const numbered = /^(\d{1,2}(\.\d{1,2})*\.?|[A-Z]\.)\s+\p{Lu}[^.,;:()]*$/u.test(t) && t.split(/\s+/).length <= 7 && gapBefore
    // 标题：罗马数字/编号独占一行；或大号短行；或居中的全大写短行；或「编号 + 短标题」且前有空行。
    // 居中但大小写正常的短行（引诗、署名）不算——它们按正文段落处理。
    // 文件名/坐标轴之类的图内碎片（"3-end.png"、单个字母）不当标题
    const junk = /\.(png|jpe?g|pdf|svg)$/i.test(t) || letters.length < 2 && !ROMAN_OR_NUM.test(t)
    const isHeading = !junk && ((short && (
      ROMAN_OR_NUM.test(t) || big || (centered && upperRatio >= 0.7 && letters.length >= 2) || numbered
    )) || (bodyH > 0 && l.h >= bodyH * 1.5 && letters.length <= 150))
    const isNote = bodyH > 0 && l.h < bodyH * 0.82
    if (isHeading) {
      push('heading', l)
      cur = null // 标题后必然新起一段
      continue
    }
    const kind: ParagraphKind = isNote ? 'note' : 'body'
    if (!cur || cur.kind !== kind) {
      cur = push(CAPTION.test(l.text) ? 'caption' : kind, l)
      continue
    }
    const ref = Math.min(prev?.x0 ?? l.x0, next?.x0 ?? Infinity)
    const indent = l.x0 - ref
    const h = Math.max(l.h, 1)
    // 缩进只在上一行像段尾时才断段：首字下沉占两三行，后面几行整体右移，但上一行并没有结束句子
    const prevEnds = prev ? SENT_END.test(prev.text) || prev.x1 < bodyRight - width * 0.12 : true
    const indented = indent > 0.9 * h && indent < 8 * h && prevEnds
    const bigGap = prev ? prev.y - l.y > lineGap * 1.6 : false
    const prevShortEnd = prev ? prev.x1 < bodyRight - width * 0.12 && SENT_END.test(prev.text) : false
    if (indented || bigGap || prevShortEnd || CAPTION.test(l.text)) {
      cur = push(CAPTION.test(l.text) ? 'caption' : kind, l)
      continue
    }
    cur.lines.push(l)
  }
  return out
}

/** 行拼段：行尾连字符 + 下一行小写开头 → 去掉连字符直接接；否则补空格。spans 的区间随文本同步。 */
export function joinLines(lines: Line[]): { text: string; spans: Span[] } {
  let text = ''
  const spans: Span[] = []
  for (const l of lines) {
    const lineText = l.text
    const pieces = l.pieces
    if (text) {
      if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(lineText)) {
        text = text.slice(0, -1)
        const last = spans[spans.length - 1]
        if (last && last[1] > text.length) last[1] = text.length
      } else {
        text += ' '
      }
    }
    const base = text.length
    text += lineText
    if (!pieces.length) continue
    // 一行一个 span（矩形取整行包络；句级高亮按字符比例在行内插值，体积比逐 item 小一个量级）
    const x0 = Math.min(...pieces.map((p) => p.x))
    const x1 = Math.max(...pieces.map((p) => p.x + p.w))
    const yb = Math.min(...pieces.map((p) => p.y))
    const h = Math.max(...pieces.map((p) => p.h))
    const y = yb - 0.25 * h
    spans.push([base, base + lineText.length, l.page, r1(x0), r1(y), r1(x1 - x0), r1(h * 1.3)])
  }
  return { text, spans }
}

const r1 = (n: number) => Math.round(n * 10) / 10

/** 核心：多页原始文本层 → 段落列表。 */
export function paragraphsFromPages(pages: RawPage[]): { paragraphs: Paragraph[]; notes: string[] } {
  const regions: Region[] = []
  let spreads = 0
  let columns = 0
  for (const p of pages) {
    const rs = pageRegions(p, buildLines(p))
    if (rs.length === 2) rs[0]!.logical ? spreads++ : columns++
    regions.push(...rs)
  }
  const { removed } = stripRunningHeads(regions)
  const drafts: Draft[] = []
  for (const r of regions) {
    const ds = regionParagraphs(r)
    if (!ds.length) continue
    // 跨区域续段：上一段是正文且没以句末标点收尾、本区域首段也是正文 → 接上
    const prev = drafts[drafts.length - 1]
    const first = ds[0]!
    if (prev && prev.kind === 'body' && first.kind === 'body') {
      const lastLine = prev.lines[prev.lines.length - 1]!
      if (!SENT_END.test(lastLine.text) && !/^\p{Lu}/u.test(first.lines[0]!.text.trim()) || /\p{L}-$/u.test(lastLine.text)) {
        prev.lines.push(...first.lines)
        ds.shift()
      }
    }
    drafts.push(...ds)
  }
  const paragraphs: Paragraph[] = []
  for (const d of drafts) {
    const { text, spans } = joinLines(d.lines)
    if (!text.trim()) continue
    paragraphs.push({
      id: `p${paragraphs.length + 1}`,
      kind: d.kind === 'body' && CAPTION.test(text) ? 'caption' : d.kind,
      page: d.lines[0]!.page,
      label: d.label,
      text,
      spans,
    })
  }
  const notes: string[] = []
  if (spreads) notes.push(`${spreads} 张 PDF 页识别为左右跨页，已按两页书分别切分`)
  if (columns) notes.push(`${columns} 张 PDF 页识别为双栏`)
  if (removed) notes.push(`剔除页眉/页码/噪声行 ${removed} 行`)
  return { paragraphs, notes }
}

/** 读 PDF 文本层（pdf.js legacy build，纯 Node）。 */
export async function readRawPages(pdfPath: string): Promise<{ pages: RawPage[]; sizes: Array<[number, number]>; origins: Array<[number, number]> }> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await readFile(pdfPath))
  const loadingTask = getDocument({ data, disableFontFace: true, verbosity: 0 })
  const doc = await loadingTask.promise
  try {
    const pages: RawPage[] = []
    const sizes: Array<[number, number]> = []
    const origins: Array<[number, number]> = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const vp = page.getViewport({ scale: 1 })
      // 坐标保持 PDF 原始用户空间（不减 view 原点）：阅读器的 viewport.convertToViewportRectangle 吃的就是它
      const [vx, vy] = page.view as [number, number, number, number]
      const tc = await page.getTextContent()
      const items: RawItem[] = []
      for (const raw of tc.items) {
        const it = raw as { str?: unknown; transform?: number[]; width?: number; height?: number; hasEOL?: boolean }
        if (typeof it.str !== 'string' || !it.transform) continue
        const [a, b, c, d, e, f] = it.transform as [number, number, number, number, number, number]
        const h = it.height || Math.hypot(c, d) || Math.hypot(a, b)
        items.push({ str: it.str, x: e, y: f, w: it.width ?? 0, h, eol: it.hasEOL === true })
      }
      pages.push({ page: i, width: vp.width, height: vp.height, items })
      sizes.push([r1(vp.width), r1(vp.height)])
      origins.push([vx, vy])
      page.cleanup()
    }
    return { pages, sizes, origins }
  } finally {
    await loadingTask.destroy()
  }
}

// ── MinerU content_list → 段落（纯图片扫描件） ────────────────────────────

/** MinerU 块（宽松读取；bbox 为 0~1000 归一化，若分量 > 1000 视为页面单位）。 */
export function paragraphsFromMineru(
  blocks: ReadonlyArray<Record<string, unknown>>,
  sizes: Array<[number, number]>,
  origins: Array<[number, number]> = [],
): Paragraph[] {
  const maxComp = Math.max(0, ...blocks.flatMap((b) => Array.isArray(b['bbox']) ? (b['bbox'] as number[]) : []))
  const normalized = maxComp <= 1000
  const out: Paragraph[] = []
  for (const b of blocks) {
    const type = String(b['type'] ?? 'text')
    const pageIdx = typeof b['page_idx'] === 'number' ? (b['page_idx'] as number) : 0
    const page = pageIdx + 1
    const [W, H] = sizes[pageIdx] ?? [612, 792]
    const [ox, oy] = origins[pageIdx] ?? [0, 0]
    let text = ''
    let kind: ParagraphKind = 'body'
    if (type === 'text' || type === 'title') {
      text = String(b['text'] ?? '').trim()
      if (type === 'title' || (typeof b['text_level'] === 'number' && (b['text_level'] as number) >= 1)) kind = 'heading'
    } else if (type === 'image' || type === 'table') {
      const cap = b[type === 'image' ? 'img_caption' : 'table_caption'] ?? b['image_caption'] ?? b['table_caption']
      text = (Array.isArray(cap) ? cap.join(' ') : String(cap ?? '')).trim() || (type === 'image' ? '[图]' : '[表]')
      kind = 'figure'
    } else if (type === 'equation') {
      continue // 公式块不单独成段（划词/公式面板另有通道）
    } else {
      continue
    }
    if (!text) continue
    const bb = Array.isArray(b['bbox']) ? (b['bbox'] as number[]) : null
    const spans: Span[] = []
    if (bb && bb.length === 4) {
      const [x0, y0, x1, y1] = normalized ? [bb[0]! / 1000 * W, bb[1]! / 1000 * H, bb[2]! / 1000 * W, bb[3]! / 1000 * H] : bb as [number, number, number, number]
      spans.push([0, text.length, page, r1(ox + x0), r1(oy + H - y1), r1(x1 - x0), r1(y1 - y0)])
    }
    out.push({ id: `p${out.length + 1}`, kind: kind === 'body' && CAPTION.test(text) ? 'caption' : kind, page, label: null, text, spans })
  }
  return out
}

/**
 * 入口：PDF → DigestDoc。文本层足量走 pdf.js；文本层几乎为空（纯图片扫描件）且有 MinerU 产物时走 MinerU；
 * 两者都没有则抛错，由上层提示「先用 MinerU 转录」。
 */
export async function extractDigestDoc(pdfPath: string, mineruJsonPath: string): Promise<DigestDoc> {
  const { pages, sizes, origins } = await readRawPages(pdfPath)
  const chars = pages.reduce((s, p) => s + p.items.reduce((t, i) => t + i.str.trim().length, 0), 0)
  const textLayerOk = chars >= 100 * Math.max(1, pages.length)
  if (textLayerOk) {
    const { paragraphs, notes } = paragraphsFromPages(pages)
    return { source: 'pdfjs', pageCount: pages.length, pageSizes: sizes, paragraphs, notes }
  }
  let blocks: Array<Record<string, unknown>> | null = null
  try {
    const raw = JSON.parse(await readFile(mineruJsonPath, 'utf8')) as unknown
    // transcribe.ts 落盘形状：{ v, producer, pageCount, contentList: [...] }；兼容直接是数组的旧/外来产物
    const arr = Array.isArray(raw) ? raw : (raw as { contentList?: unknown; content_list?: unknown })?.contentList ?? (raw as { content_list?: unknown })?.content_list
    if (Array.isArray(arr)) blocks = arr as Array<Record<string, unknown>>
  } catch { /* 没有 MinerU 产物 */ }
  if (!blocks?.length) {
    throw new Error('这份 PDF 没有可用的文本层（纯图片扫描件）。请先在「∑ 公式」面板或设置里启用 MinerU，用 MinerU 重新转录后再生成精读。')
  }
  return {
    source: 'mineru',
    pageCount: pages.length,
    pageSizes: sizes,
    paragraphs: paragraphsFromMineru(blocks, sizes, origins),
    notes: ['文本层为空，段落取自 MinerU OCR（重点句高亮只能精确到段落块）'],
  }
}
