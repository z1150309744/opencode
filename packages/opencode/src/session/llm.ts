import { Provider } from "@/provider"
import { Log } from "@/util"
import { Context, Effect, Layer, Record } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool, tool, jsonSchema } from "ai"
import { mergeDeep, pipe } from "remeda"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider"
import { Config } from "@/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard } from "@/util"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { Installation } from "@/installation"
import { InstallationVersion } from "@/installation/version"
import { EffectBridge } from "@/effect"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"

const log = Log.create({ service: "llm" })
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX
type Result = Awaited<ReturnType<typeof streamText>>

export type StreamInput = {
  // 当前触发本次 LLM 调用的用户消息。包含 user.system（用户级 system prompt 追加项）、
  // user.tools（工具白/黑名单覆盖）、user.id（请求关联标识，写入 x-opencode-request 头）、
  // user.model.variant（决定使用模型的哪个 variant 配置）等
  user: MessageV2.User
  // 当前会话 ID。用于日志 tag、telemetry 元数据、权限请求关联、自定义 HTTP header
  // （x-opencode-session / x-session-affinity）和工具执行时的 session 上下文
  sessionID: string
  // 父会话 ID（可选）。当本次调用是 subtask/嵌套会话时使用，会作为 x-parent-session-id
  // 头传给非 opencode provider，用于服务端追踪父子会话关系
  parentSessionID?: string
  // 模型描述对象。包含 providerID（提供商 ID）、id（模型 ID）、capabilities（能力开关，
  // 如是否支持 temperature）、options（模型默认 provider options）、variants（模型变体配置）、
  // headers（模型级别自定义请求头）、api（API 路径信息）等
  model: Provider.Model
  // 当前生效的 agent 配置。包含 prompt（agent 专属 system prompt，存在则覆盖 provider 默认）、
  // permission（agent 权限规则集，与 input.permission 合并）、options（agent 级 provider options
  // 覆盖）、temperature/topP（采样参数覆盖）、name/mode（用于日志 tag 和提示注入）
  agent: Agent.Info
  // 会话级权限规则集（可选）。会与 agent.permission 通过 Permission.merge 合并，
  // 决定哪些工具被禁用/需要审批，以及 GitLab Workflow 模式下哪些工具属于"已预批准"
  permission?: Permission.Ruleset
  // 调用方追加的额外 system prompt 数组。会与 agent prompt、user.system 拼接成最终 system 消息；
  // 同时支持插件通过 experimental.chat.system.transform 钩子修改后再注入到 messages
  system: string[]
  // 已经转换为 AI SDK ModelMessage 格式的历史消息列表。除了 OpenAI OAuth 和 GitLab Workflow
  // 这两种特殊路径外，最终发送给模型时会在前面拼接 system 消息
  messages: ModelMessage[]
  // 是否走"小模型/快速"路径（可选）。true 时使用 ProviderTransform.smallOptions 简化 provider 选项，
  // 并跳过 variant 解析。用于摘要、标题生成等不需要完整能力的内部调用
  small?: boolean
  // 本次调用可用的工具映射表（toolName → AI SDK Tool 定义）。会经过 resolveTools 根据
  // user.tools 覆盖和权限规则过滤，并可能注入 _noop 占位工具以满足 LiteLLM 类代理的校验
  tools: Record<string, Tool>
  // AI SDK 内置的最大重试次数（可选，默认 0）。设为 0 表示禁用 SDK 层重试，
  // 由 OpenCode 外层的 SessionRetry 策略统一接管重试逻辑
  retries?: number
  // 工具选择策略（可选）。"auto" 由模型自行决定是否调用工具；"required" 强制必须调用某个工具
  // （用于 JSON 结构化输出场景，配合虚拟 StructuredOutput 工具）；"none" 禁止工具调用
  toolChoice?: "auto" | "required" | "none"
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export type Event = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<Event, unknown> //LLM.stream
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

const live: Layer.Layer<
  Service,
  never,
  Auth.Service | Config.Service | Provider.Service | Plugin.Service | Permission.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      const l = log
        .clone()
        .tag("providerID", input.model.providerID)
        .tag("modelID", input.model.id)
        .tag("session.id", input.sessionID)
        .tag("small", (input.small ?? false).toString())
        .tag("agent", input.agent.name)
        .tag("mode", input.agent.mode)
      l.info("stream", {
        modelID: input.model.id,
        providerID: input.model.providerID,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),//AI SDK 的 LanguageModelV3 实例，是实际发 HTTP 请求的对象
          config.get(),//读取当前合并后的配置对象（全局 + 项目 + 环境变量）
          provider.getProvider(input.model.providerID), //包含provider 的 id、source、env、options（SDK 工厂参数如 baseURL、litellmProxy 标记等）、models
          auth.get(input.model.providerID), //该 provider 的认证信息（类型：oauth / api-key / none）
        ],
        { concurrency: "unbounded" },
      )

      // TODO: 移到合适的 hook 中处理
      // OpenAI OAuth 路径使用 Responses API，该 API 的 system prompt
      // 通过 instructions 字段传递而非 messages 数组中的 system role 消息
      const isOpenaiOauth = item.id === "openai" && info?.type === "oauth"

      const system: string[] = []
      system.push(
        [
          // 优先使用 agent prompt（自定义提示），否则使用 provider prompt
          ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
          //来自 processor 注入的环境信息、skills 描述等
          ...input.system,
          //用户消息中携带的自定义 system prompt
          ...(input.user.system ? [input.user.system] : []),
        ]
          .filter((x) => x)
          .join("\n"),
      )

      const header = system[0]
      yield* plugin.trigger(
        "experimental.chat.system.transform",
        { sessionID: input.sessionID, model: input.model },
        { system },
      )
      // 如果 header 未变，重新合并以保持两部分结构用于缓存
      if (system.length > 2 && system[0] === header) {
        const rest = system.slice(1)
        system.length = 0
        system.push(header, rest.join("\n"))
      }

      //非 small 模式下，如果用户消息指定了变体名（如 "high"、"max"），从模型预定义的 variants 映射中取出对应的配置对象
      const variant =
        !input.small && input.model.variants && input.user.model.variant
          ? input.model.variants[input.user.model.variant]
          : {}
      const base = input.small
        ? ProviderTransform.smallOptions(input.model)
        : ProviderTransform.options({
            model: input.model,
            sessionID: input.sessionID,
            providerOptions: item.options,
          })
      const options: Record<string, any> = pipe(
        base,//provider 通用默认值（如 Anthropic 的 cacheControl、maxTokens 等）
        mergeDeep(input.model.options),//models.dev 或opencode.json 中该模型的特殊参数
        mergeDeep(input.agent.options),//agent 配置中的覆盖
        mergeDeep(variant),//用户选择的推理变体覆盖）。后者覆盖前者的同名字段
      )
      if (isOpenaiOauth) {//OpenAI OAuth 模式下，system prompt 走 instructions 字段而非 messages
        options.instructions = system.join("\n")
      }

      /**
       *  三条路径：
       *  1.OpenAI OAuth：system 已放入 options.instructions，messages 直接使用历史消息
       *  2.GitLab Workflow：system 通过后面的 workflowModel.systemPrompt 属性传递，messages 直接使用
       *  3.将 system 数组中的每个字符串转为 {role: "system", content: x} 消息，拼在历史消息前面
       */
      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const messages = isOpenaiOauth
        ? input.messages
        : isWorkflow
          ? input.messages
          : [
              ...system.map(
                (x): ModelMessage => ({
                  role: "system",
                  content: x,
                }),
              ),
              ...input.messages,
            ]

      //让插件修改 LLM 的采样参数和 provider options。
      const params = yield* plugin.trigger(
        "chat.params",
        {
          sessionID: input.sessionID,
          agent: input.agent.name,
          model: input.model,
          provider: item,
          message: input.user,
        },
        {
          temperature: input.model.capabilities.temperature
            ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
            : undefined,
          topP: input.agent.topP ?? ProviderTransform.topP(input.model),
          topK: ProviderTransform.topK(input.model),
          maxOutputTokens: ProviderTransform.maxOutputTokens(input.model),
          options, //之前分层合并好的完整 providerOptions 对象
        },
      )

      //让插件注入自定义 HTTP 请求头。插件添加认证 token、trace ID、自定义路由标记等
      const { headers } = yield* plugin.trigger(
        "chat.headers",
        {
          sessionID: input.sessionID,
          agent: input.agent.name,
          model: input.model,
          provider: item,
          message: input.user,
        },
        {
          headers: {},
        },
      )

      const tools = resolveTools(input)

      //当对话历史（input.messages）中包含工具调用记录（tool-call 或 tool-result），但当前轮次的可用工具列表为空时，某些 API
      //   代理（LiteLLM、GitHub Copilot）会校验失败——它们要求：如果消息中出现了工具调用内容，请求的 tools 字段就不能为空数组。
      const isLiteLLMProxy =
        item.options?.["litellmProxy"] === true ||
        input.model.providerID.toLowerCase().includes("litellm") ||
        input.model.api.id.toLowerCase().includes("litellm")

      if (
        (isLiteLLMProxy || input.model.providerID.includes("github-copilot")) &&
        Object.keys(tools).length === 0 &&
        hasToolCalls(input.messages)
      ) {
        tools["_noop"] = tool({
          description: "不要使用此工具。此工具仅用于满足 API 的兼容性要求，切勿调用它。",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              reason: { type: "string", description: "Unused" },
            },
          }),
          execute: async () => ({ output: "", title: "", metadata: {} }),
        })
      }

      //解决的核心问题是：GitLab Workflow 是一个服务端驱动的模型（模型运行在 GitLab
      //服务端，通过 WebSocket 与客户端通信），而 OpenCode 的工具系统是本地的。这段代码在两者之间架起桥梁
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {//注册工具执行器：GitLab Workflow 是服务端驱动的模型，工具调用通过 WebSocket 回传给客户端执行。这个回调接收工具名和参数 JSON，在本地查找对应的 tool 定义并执行，返回结果
          const t = tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const bridge = yield* EffectBridge.make()
        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = Instance.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // 自动批准本次会话中已批准过的工具
          // （防止服务端 MCP 工具陷入无限审批循环）
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionID.ascending()
          let unsub: (() => void) | undefined
          try {
            unsub = Bus.subscribe(Permission.Event.Replied, (evt) => {
              if (evt.properties.requestID === id) void evt.properties.reply
            })
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            unsub?.()
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      return streamText({
        onError(error) {
          l.error("stream error", {
            error,
          })
        },
        /**
         * 当模型输出的工具调用名在 tools 映射表中找不到时触发的修复逻辑
         *   - 先尝试小写化匹配（ReadFile → readfile）
         *   - 仍然失败则重定向到名为 invalid 的工具，把原始工具名和错误信息作为参数传入，让 agent 知道调用失败并能自行修正
         */
        async experimental_repairToolCall(failed) {
          const lower = failed.toolCall.toolName.toLowerCase()
          if (lower !== failed.toolCall.toolName && tools[lower]) {
            l.info("repairing tool call", {
              tool: failed.toolCall.toolName,
              repaired: lower,
            })
            return {
              ...failed.toolCall,
              toolName: lower,
            }
          }
          return {
            ...failed.toolCall,
            input: JSON.stringify({
              tool: failed.toolCall.toolName,
              error: failed.error.message,
            }),
            toolName: "invalid",
          }
        },
        temperature: params.temperature, //控制模型输出的随机性。值越高输出越多样，值越低越确定
        topP: params.topP, //核采样（nucleus sampling），只从累计概率前 P% 的 token 中选择
        topK: params.topK, //只从概率最高的前 K 个 token 中选择
        providerOptions: ProviderTransform.providerOptions(input.model, params.options), //provider 特有的扩展参数。例如 Anthropic 的 cacheControl、budgetTokens（thinking 模式）等
        activeTools: Object.keys(tools).filter((x) => x !== "invalid"), //当前可用工具列表
        tools, //完整的工具定义映射表（toolName → Tool），包含每个工具的 schema 和 execute 函数
        toolChoice: input.toolChoice, //控制工具调用策略："auto" 由模型决定，"required" 强制调用（用于 JSON 结构化输出），"none" 禁止
        maxOutputTokens: params.maxOutputTokens,
        abortSignal: input.abort, //传入 AbortController.signal，允许外部取消正在进行的 HTTP 请求
        headers: {
          ...(input.model.providerID.startsWith("opencode")
            ? {
                "x-opencode-project": Instance.project.id,
                "x-opencode-session": input.sessionID,
                "x-opencode-request": input.user.id,
                "x-opencode-client": Flag.OPENCODE_CLIENT,
              }
            : {
                "x-session-affinity": input.sessionID,
                ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
                "User-Agent": `opencode/${InstallationVersion}`,
              }),
          ...input.model.headers,//叠加模型级别自定义头
          ...headers,//插件注入的头
        },
        maxRetries: input.retries ?? 0,
        messages,
        model: wrapLanguageModel({
          model: language,
          middleware: [
            {
              specificationVersion: "v3" as const,
              async transformParams(args) {
                if (args.type === "stream") {
                  // @ts-expect-error
                  args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
                }
                return args.params
              },
            },
          ],
        }),
        experimental_telemetry: {
          isEnabled: cfg.experimental?.openTelemetry,
          functionId: "session.llm",
          tracer: telemetryTracer,
          metadata: {
            userId: cfg.username ?? "unknown",
            sessionId: input.sessionID,
          },
        },
      })
    })

    /**
     * @param input LLM.stream实现
     */
    const stream: Interface["stream"] = (input) =>
      //将一个依赖 Scope 的 Stream 提升为自包含的 Stream
      //内部的 Effect.acquireRelease 需要一个 Scope 来注册资源释放器。Stream.scoped 为整个 Stream 生命周期提供这个
      //Scope——当 Stream 被消费完毕、出错或被中断时，Scope 关闭，触发所有注册的释放器（即 ctrl.abort()）
      Stream.scoped(
        //签名是 Effect<Stream<A, E>> => Stream<A, E>。它将一个"返回 Stream 的 Effect"展平为一个"Stream"
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              // TODO zouwenwen.5 AbortController设计原理
              Effect.sync(() => new AbortController()),
              //当 Scope 关闭时，调用 ctrl.abort()，向 AI SDK 的底层HTTP 请求发送中止信号
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })
            //将 AI SDK 的 fullStream（一个 AsyncIterable<Event>）转换为 Effect-TS 的 Stream<Event, Error>
            return Stream.fromAsyncIterable(result.fullStream, (e) => (e instanceof Error ? e : new Error(String(e))))
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const layer = live.pipe(Layer.provide(Permission.defaultLayer))

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
  ),
)

function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

// 检查消息中是否包含工具调用内容
// 用于判断是否需要为 LiteLLM 代理兼容性添加占位工具
export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLM from "./llm"
