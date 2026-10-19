// digest-run.ts — 精读生成的编排引擎（纯逻辑，subagent 派发由调用方注入）。
//
// 流程：分节（outline 子代理；短文/失败时启发式兜底）→ 按 digest.ts 规划的任务并发派发
// （每节一个分析子代理 + 若干翻译子代理）→ 每完成一个就合并写盘 → 全部分析齐后派一个总览子代理。
// 单个任务失败重试一次，仍失败记入 job.errors 继续跑别的；停止请求在派发下一个任务前生效。

import type { PaperRef } from './library.ts'
import {
  ANALYZE_SCHEMA,
  OUTLINE_SCHEMA,
  OVERVIEW_SCHEMA,
  TRANSLATE_SCHEMA,
  analyzePrompt,
  heuristicSections,
  mergeAnalysis,
  mergeOverview,
  mergeTranslations,
  outlinePrompt,
  overviewPrompt,
  planTasks,
  readDigest,
  sectionsFromOutline,
  translatePrompt,
  updateDigest,
  type DigestFile,
  type Task,
} from './digest.ts'

/** 派发一个子代理并等待它的结构化结果（失败抛错）。 */
export type Spawn = (label: string, prompt: string, schema: object, signal: AbortSignal) => Promise<unknown>

export interface RunOptions {
  concurrency?: number
  signal?: AbortSignal
  heartbeatMs?: number
}

const now = () => new Date().toISOString()
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

export async function runDigestJob(ref: PaperRef, jobId: string, spawn: Spawn, opts: RunOptions = {}): Promise<string> {
  const concurrency = Math.max(1, opts.concurrency ?? 4)
  const ac = new AbortController()
  opts.signal?.addEventListener('abort', () => ac.abort(), { once: true })
  const signal = ac.signal

  const start = await readDigest(ref)
  if (!start?.job || start.job.id !== jobId) throw new Error('找不到这个精读任务（可能已被新的任务取代）')
  let stopRequested = false
  const touch = (fn?: (d: DigestFile) => void) => updateDigest(ref, (d) => {
    if (!d.job || d.job.id !== jobId) { stopRequested = true; return }
    fn?.(d)
    d.job.updatedAt = now()
    if (d.job.stopRequested) stopRequested = true
  })
  await touch((d) => { d.job!.state = 'running'; d.job!.message = '准备中' })
  const heartbeat = setInterval(() => { touch().catch(() => {}) }, opts.heartbeatMs ?? 20_000)

  try {
    // 1) 分节
    let d = (await readDigest(ref))!
    if (!d.outline) {
      await touch((x) => { x.job!.message = '正在划分章节' })
      let outline: DigestFile['outline'] = null
      if (d.doc.paragraphs.length > 8) {
        try {
          const raw = await withRetry(() => spawn('精读·分节', outlinePrompt(d), OUTLINE_SCHEMA, signal), signal) as {
            title?: string; kind?: string; sections?: Array<{ startPid: string; title: string }>
          }
          const sections = sectionsFromOutline(d.doc.paragraphs, raw.sections ?? [])
          if (sections.length) outline = { title: String(raw.title ?? '').trim() || ref.name, kind: String(raw.kind ?? 'other'), sections, source: 'model' }
        } catch (e) {
          if (signal.aborted) throw e
          await touch((x) => { x.job!.errors.push(`分节子代理失败，改用自动分节：${short(e)}`) })
        }
      }
      outline ??= { title: ref.name, kind: 'other', sections: heuristicSections(d.doc.paragraphs), source: 'heuristic' }
      await touch((x) => { x.outline = outline })
      d = (await readDigest(ref))!
    }

    // 2) 规划
    const all = d.outline!.sections.map((s) => s.id)
    const scope = d.job!.scope === 'all' ? all : all.filter((id) => (d.job!.scope as string[]).includes(id))
    const tasks = planTasks(d, scope, d.job!.force)
    const willHaveAll = all.every((id) => d.analyses[id] || tasks.some((t) => t.kind === 'analyze' && t.sectionId === id))
    const wantOverview = willHaveAll && (d.job!.force || !d.overview || tasks.some((t) => t.kind === 'analyze'))
    if (wantOverview) tasks.push({ kind: 'overview' })
    await touch((x) => { x.job!.total = tasks.length; x.job!.done = 0; x.job!.message = tasks.length ? '生成中' : '没有需要生成的内容' })

    // 3) 并发派发（总览必须等所有分析写完，单独放最后）
    const main = tasks.filter((t) => t.kind !== 'overview')
    let failed = 0
    let next = 0
    const worker = async () => {
      while (next < main.length && !stopRequested && !signal.aborted) {
        const task = main[next++]!
        try {
          await runTask(ref, task, spawn, signal)
        } catch (e) {
          if (signal.aborted) return
          failed++
          await touch((x) => { if (x.job!.errors.length < 30) x.job!.errors.push(`${taskLabel(x, task)}：${short(e)}`) })
        }
        await touch((x) => { x.job!.done++ })
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, main.length) }, worker))

    if (wantOverview && !stopRequested && !signal.aborted) {
      const cur = (await readDigest(ref))!
      if (cur.outline!.sections.every((s) => cur.analyses[s.id])) {
        await touch((x) => { x.job!.message = '正在写全文总览' })
        try {
          const raw = await withRetry(() => spawn('精读·全文总览', overviewPrompt(cur), OVERVIEW_SCHEMA, signal), signal)
          await touch((x) => mergeOverview(x, raw))
        } catch (e) {
          failed++
          await touch((x) => { x.job!.errors.push(`全文总览：${short(e)}`) })
        }
      }
      await touch((x) => { x.job!.done++ })
    }

    // 主任务（分析/翻译）一个都没成功才算出错；部分失败仍是「完成」，错误列表里逐条可见
    const final = stopRequested ? 'stopped' : main.length > 0 && failed >= main.length ? 'error' : 'done'
    const msg = stopRequested ? '已停止' : final === 'error' ? `全部 ${failed} 个任务失败（见下方错误列表）` : failed ? `完成，${failed} 个任务失败` : '完成'
    await touch((x) => { x.job!.state = final; x.job!.message = msg })
    return `精读生成${msg}：${tasks.length - failed}/${tasks.length} 个任务成功。`
  } catch (e) {
    await touch((x) => { x.job!.state = signal.aborted ? 'stopped' : 'error'; x.job!.message = short(e) }).catch(() => {})
    throw e
  } finally {
    clearInterval(heartbeat)
  }
}

function taskLabel(d: DigestFile, t: Task): string {
  if (t.kind === 'overview') return '全文总览'
  const s = d.outline?.sections.find((x) => x.id === t.sectionId)
  const name = s ? `「${s.title}」` : t.sectionId
  return t.kind === 'analyze' ? `分析${name}${t.parts > 1 ? `（${t.part}/${t.parts}）` : ''}` : `翻译${name} ${t.pids[0]}–${t.pids[t.pids.length - 1]}`
}

async function runTask(ref: PaperRef, task: Task, spawn: Spawn, signal: AbortSignal): Promise<void> {
  const d = (await readDigest(ref))!
  if (task.kind === 'analyze') {
    const raw = await withRetry(() => spawn(`精读·${taskLabel(d, task)}`, analyzePrompt(d, task), ANALYZE_SCHEMA, signal), signal)
    await updateDigest(ref, (x) => mergeAnalysis(x, task, raw))
    return
  }
  if (task.kind === 'translate') {
    const raw = await withRetry(() => spawn(`精读·${taskLabel(d, task)}`, translatePrompt(d, task), TRANSLATE_SCHEMA, signal), signal)
    const missing = await updateDigest(ref, (x) => mergeTranslations(x, task, raw))
    if (missing.length) {
      // 漏段只补一次：只把缺的段落再派一次
      const retry = { ...task, pids: missing }
      const raw2 = await spawn(`精读·补译 ${missing.length} 段`, translatePrompt(d, retry), TRANSLATE_SCHEMA, signal)
      const still = await updateDigest(ref, (x) => mergeTranslations(x, retry, raw2))
      if (still.length) throw new Error(`${still.length} 段没有返回译文（${still.slice(0, 5).join(', ')}${still.length > 5 ? '…' : ''}）`)
    }
  }
}

async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (signal.aborted) throw e
    await new Promise((r) => setTimeout(r, 1500))
    return fn()
  }
}
