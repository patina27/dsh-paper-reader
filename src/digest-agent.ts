// digest-agent.ts — 精读编排会话里的 agent 层插件（只在「精读编排」preset 里加载）。
//
// 为什么挂在 agent 层（preset 里）而不是宿主层：startActivation 需要一个父 agent（exec.agent），
// 而且只有编排会话需要这个工具——worker 子代理用另一个 preset，看不到 digest_generate，不会递归派发。
// subagent 服务（ctx.subagents）与 spawn provider 由 dsh-base 挂在宿主层，这里直接注入。
//
// 工具本身不让模型做决定：编排会话只是一个「调用一次工具」的壳，真正的分节/并发/合并全在
// digest-run.ts，子代理一律以 structured_output 回传结果。

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolvePaper } from './library.ts'
import { runDigestJob, type Spawn } from './digest-run.ts'

export const name = 'dsh-paper-reader-digest'
export const inject = ['tools', 'subagents']

export const WORKER_PRESET_ID = 'paper-digest-worker'

export interface DigestAgentConfig {
  /** 同时运行的子代理数 */
  concurrency?: number
  /** 子代理用的 subagent provider（dsh-base 里 spawn 是全新上下文的进程内子代理） */
  provider?: string
}

interface ContentBlock { type: 'text'; text: string }
interface SubagentResultLike {
  structured?: unknown
  diagnostic?: string
  stopReason: string
  output: readonly unknown[]
}
interface RunLike { result: Promise<SubagentResultLike>; dispose(): Promise<void> }
/**
 * ctx.subagents 的两代接口（按存在的方法分派，同一份插件两边都能跑）：
 *  - dsh 0.2.0-rc.x：start(provider, { prompt, parent, signal, outputSchema, persona, toolFilter })——
 *    子代理沿用父会话的组合，靠 persona 换角色、toolFilter 收掉全部全局工具（含 digest_generate）；
 *  - 更新的 dsh：startActivation({ provider, request: { …, agentPreset } , delivery })——
 *    子代理用 bundle patch 里声明的 paper-digest-worker preset（同样没有工具）。
 */
interface SubagentsLike {
  start?(provider: string, request: {
    label: string
    prompt: ContentBlock[]
    parent: unknown
    signal: AbortSignal
    outputSchema?: object
    persona?: string
    toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }
  }): Promise<RunLike>
  startActivation?(spec: {
    provider: string
    label: string
    request: { prompt: ContentBlock[]; parent: unknown; agentPreset?: string; outputSchema?: object }
    signal: AbortSignal
    delivery: 'parent' | 'caller'
  }): Promise<{ childId: string } & RunLike>
}

/** 子代理角色（与 cordis.patch.yml 里 paper-digest-worker 的 persona 同义；不含 {{…}} 占位符，免得严格插值报错）。 */
const WORKER_PERSONA = [
  'You are a meticulous academic reader and translator working for Chinese readers.',
  'You receive one self-contained task (translate a block of paragraphs, analyse one section, or write a whole-document overview). The source text is given in full inside the task; you have no other tools and need none.',
  'Follow the task requirements exactly, write all prose in Simplified Chinese unless the task says to copy original text verbatim, and report the result through the structured_output tool in a single call.',
].join('\n')

export function apply(ctx: Context, config: DigestAgentConfig = {}) {
  const subagents = (ctx as unknown as { subagents: SubagentsLike }).subagents
  const provider = config.provider ?? 'spawn'
  const concurrency = config.concurrency ?? 4

  ;(ctx as unknown as { tools: { register(def: unknown): unknown } }).tools.register(defineTool({
    name: 'digest_generate',
    description:
      '为文献库里的一篇文献生成精读（逐段中文翻译、分节概括/总结/批判点评、高中生版讲解、重点句与图）。' +
      '由阅读器的「生成精读」按钮发起，参数原样照抄用户消息里给出的 job_id / pdf_path；调用一次即可，工具会自己派发子代理并等待全部完成。',
    parameters: {
      job_id: { type: 'string', required: true, description: '精读任务 id（原样照抄）' },
      pdf_path: { type: 'string', required: true, description: 'PDF 绝对路径（原样照抄）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: { summary: { type: 'string', required: true } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    execute: async (args, exec) => {
      const parent = exec.agent
      if (!parent) throw new Error('digest_generate 需要在 agent 会话里调用')
      // 只认 .digest.json 里登记过的 job_id（runDigestJob 校验），路径本身不授予任何额外能力
      const ref = resolvePaper('', { path: args.pdf_path })
      const spawn: Spawn = async (label, prompt, schema, signal) => {
        const content: ContentBlock[] = [{ type: 'text', text: prompt }]
        let run: RunLike
        if (typeof subagents.startActivation === 'function') {
          run = await subagents.startActivation({
            provider,
            label,
            request: { prompt: content, parent, agentPreset: WORKER_PRESET_ID, outputSchema: schema },
            signal,
            delivery: 'caller',
          })
        } else if (typeof subagents.start === 'function') {
          run = await subagents.start(provider, {
            label, prompt: content, parent, signal, outputSchema: schema, persona: WORKER_PERSONA, toolFilter: { allow: [] },
          })
        } else {
          throw new Error('当前 dsh 版本的 subagent 服务不支持程序化派发（没有 start / startActivation）')
        }
        const onAbort = () => { run.dispose().catch(() => {}) }
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          const res = await run.result
          if (res.structured === undefined || res.structured === null) {
            throw new Error(`子代理未返回结构化结果（${res.stopReason}${res.diagnostic ? '：' + res.diagnostic.slice(0, 200) : ''}）`)
          }
          return res.structured
        } finally {
          signal.removeEventListener('abort', onAbort)
          run.dispose().catch(() => {})
        }
      }
      const summary = await runDigestJob(ref, args.job_id, spawn, { concurrency, signal: exec.signal })
      return { summary }
    },
  }))
}
