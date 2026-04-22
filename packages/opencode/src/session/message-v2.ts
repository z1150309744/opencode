import { BusEvent } from "@/bus/bus-event"
import { SessionID, MessageID, PartID } from "./schema"
import z from "zod"
import { NamedError } from "@opencode-ai/shared/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { LSP } from "../lsp"
import { Snapshot } from "@/snapshot"
import { SyncEvent } from "../sync"
import { Database, NotFoundError, and, desc, eq, inArray, lt, or } from "@/storage"
import { MessageTable, PartTable, SessionTable } from "./session.sql"
import { ProviderError } from "@/provider"
import { iife } from "@/util/iife"
import { errorMessage } from "@/util/error"
import { isMedia } from "@/util/media"
import type { SystemError } from "bun"
import type { Provider } from "@/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect } from "effect"
import { EffectLogger } from "@/effect"

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached image(s) from tool result:"
export { isMedia }

export const OutputLengthError = NamedError.create("MessageOutputLengthError", z.object({}))
export const AbortedError = NamedError.create("MessageAbortedError", z.object({ message: z.string() }))
export const StructuredOutputError = NamedError.create(
  "StructuredOutputError",
  z.object({
    message: z.string(),
    retries: z.number(),
  }),
)
export const AuthError = NamedError.create(
  "ProviderAuthError",
  z.object({
    providerID: z.string(),
    message: z.string(),
  }),
)
export const APIError = NamedError.create(
  "APIError",
  z.object({
    message: z.string(),
    statusCode: z.number().optional(),
    isRetryable: z.boolean(),
    responseHeaders: z.record(z.string(), z.string()).optional(),
    responseBody: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  }),
)
export type APIError = z.infer<typeof APIError.Schema>
export const ContextOverflowError = NamedError.create(
  "ContextOverflowError",
  z.object({ message: z.string(), responseBody: z.string().optional() }),
)

export const OutputFormatText = z
  .object({
    type: z.literal("text"),
  })
  .meta({
    ref: "OutputFormatText",
  })

export const OutputFormatJsonSchema = z
  .object({
    type: z.literal("json_schema"),
    schema: z.record(z.string(), z.any()).meta({ ref: "JSONSchema" }),
    retryCount: z.number().int().min(0).default(2),
  })
  .meta({
    ref: "OutputFormatJsonSchema",
  })

export const Format = z.discriminatedUnion("type", [OutputFormatText, OutputFormatJsonSchema]).meta({
  ref: "OutputFormat",
})
export type OutputFormat = z.infer<typeof Format>

const PartBase = z.object({
  // Part 唯一标识符
  id: PartID.zod,
  // 所属会话 ID
  sessionID: SessionID.zod,
  // 所属消息 ID
  messageID: MessageID.zod,
})

export const SnapshotPart = PartBase.extend({
  // 类型标识：快照
  type: z.literal("snapshot"),
  // 快照标识符，用于记录某一时刻的代码状态
  snapshot: z.string(),
}).meta({
  ref: "SnapshotPart",
})
export type SnapshotPart = z.infer<typeof SnapshotPart>

export const PatchPart = PartBase.extend({
  // 类型标识：补丁
  type: z.literal("patch"),
  // 补丁的哈希值
  hash: z.string(),
  // 受影响的文件路径列表
  files: z.string().array(),
}).meta({
  ref: "PatchPart",
})
export type PatchPart = z.infer<typeof PatchPart>

export const TextPart = PartBase.extend({
  // 类型标识：文本
  type: z.literal("text"),
  // 文本内容
  text: z.string(),
  // 是否为系统合成的文本（可选），true 表示非用户直接输入，如系统提示、工具说明等
  synthetic: z.boolean().optional(),
  // 是否被忽略（可选），true 则不会发送给模型
  ignored: z.boolean().optional(),
  // 时间范围（可选），记录文本流式生成的起止时间
  time: z
    .object({
      // 开始时间（毫秒时间戳）
      start: z.number(),
      // 结束时间（可选，毫秒时间戳）
      end: z.number().optional(),
    })
    .optional(),
  // 附加元数据（可选），键值对形式的额外信息
  metadata: z.record(z.string(), z.any()).optional(),
}).meta({
  ref: "TextPart",
})
export type TextPart = z.infer<typeof TextPart>

export const ReasoningPart = PartBase.extend({
  // 类型标识：推理/思考
  type: z.literal("reasoning"),
  // 模型的推理/思考文本内容（如 Claude 的 extended thinking）
  text: z.string(),
  // 附加元数据（可选）
  metadata: z.record(z.string(), z.any()).optional(),
  // 推理过程的时间范围
  time: z.object({
    // 开始时间（毫秒时间戳）
    start: z.number(),
    // 结束时间（可选，毫秒时间戳）
    end: z.number().optional(),
  }),
}).meta({
  ref: "ReasoningPart",
})
export type ReasoningPart = z.infer<typeof ReasoningPart>

const FilePartSourceBase = z.object({
  // 源文件中选中的文本片段信息
  text: z
    .object({
      // 选中的文本内容
      value: z.string(),
      // 选中的起始位置（字符偏移）
      start: z.number().int(),
      // 选中的结束位置（字符偏移）
      end: z.number().int(),
    })
    .meta({
      ref: "FilePartSourceText",
    }),
})

export const FileSource = FilePartSourceBase.extend({
  // 来源类型：文件
  type: z.literal("file"),
  // 文件路径
  path: z.string(),
}).meta({
  ref: "FileSource",
})

export const SymbolSource = FilePartSourceBase.extend({
  // 来源类型：代码符号（如函数、类等）
  type: z.literal("symbol"),
  // 符号所在文件路径
  path: z.string(),
  // 符号在文件中的位置范围（行列信息）
  range: LSP.Range,
  // 符号名称
  name: z.string(),
  // 符号类型（LSP SymbolKind 枚举值，如 1=File, 5=Class, 6=Method, 12=Function 等）
  kind: z.number().int(),
}).meta({
  ref: "SymbolSource",
})

export const ResourceSource = FilePartSourceBase.extend({
  // 来源类型：MCP 资源
  type: z.literal("resource"),
  // MCP 客户端名称
  clientName: z.string(),
  // MCP 资源 URI
  uri: z.string(),
}).meta({
  ref: "ResourceSource",
})

export const FilePartSource = z.discriminatedUnion("type", [FileSource, SymbolSource, ResourceSource]).meta({
  ref: "FilePartSource",
})

export const FilePart = PartBase.extend({
  // 类型标识：文件附件
  type: z.literal("file"),
  // MIME 类型，如 "image/png"、"text/plain"、"application/x-directory"
  mime: z.string(),
  // 文件名（可选）
  filename: z.string().optional(),
  // 文件内容 URL（file:// 本地路径或 data: base64 编码）
  url: z.string(),
  // 文件来源信息（可选），记录文件/符号/MCP资源的原始位置
  source: FilePartSource.optional(),
}).meta({
  ref: "FilePart",
})
export type FilePart = z.infer<typeof FilePart>

export const AgentPart = PartBase.extend({
  // 类型标识：Agent 引用（用户通过 @agent 引用）
  type: z.literal("agent"),
  // 引用的 Agent 名称
  name: z.string(),
  // 引用在原始输入中的位置（可选）
  source: z
    .object({
      // @agent 的原始文本
      value: z.string(),
      // 起始字符偏移
      start: z.number().int(),
      // 结束字符偏移
      end: z.number().int(),
    })
    .optional(),
}).meta({
  ref: "AgentPart",
})
export type AgentPart = z.infer<typeof AgentPart>

export const CompactionPart = PartBase.extend({
  // 类型标识：上下文压缩
  type: z.literal("compaction"),
  // 是否为自动触发的压缩（true = token 超限自动触发，false = 用户手动触发）
  auto: z.boolean(),
  // 是否因为上下文溢出而触发（可选）
  overflow: z.boolean().optional(),
  // 压缩后保留的尾部消息起始 ID（可选），用于保留最近的未压缩消息
  tail_start_id: MessageID.zod.optional(),
}).meta({
  ref: "CompactionPart",
})
export type CompactionPart = z.infer<typeof CompactionPart>

export const SubtaskPart = PartBase.extend({
  // 类型标识：子任务
  type: z.literal("subtask"),
  // 子任务的提示词内容
  prompt: z.string(),
  // 子任务描述
  description: z.string(),
  // 执行子任务的 Agent 名称
  agent: z.string(),
  // 子任务使用的模型（可选），不指定则继承父任务模型
  model: z
    .object({
      // 提供者 ID
      providerID: ProviderID.zod,
      // 模型 ID
      modelID: ModelID.zod,
    })
    .optional(),
  // 触发子任务的命令名称（可选）
  command: z.string().optional(),
}).meta({
  ref: "SubtaskPart",
})
export type SubtaskPart = z.infer<typeof SubtaskPart>

export const RetryPart = PartBase.extend({
  // 类型标识：重试记录
  type: z.literal("retry"),
  // 重试次数（第几次重试）
  attempt: z.number(),
  // 触发重试的 API 错误信息
  error: APIError.Schema,
  // 重试发生的时间
  time: z.object({
    // 创建时间（毫秒时间戳）
    created: z.number(),
  }),
}).meta({
  ref: "RetryPart",
})
export type RetryPart = z.infer<typeof RetryPart>

export const StepStartPart = PartBase.extend({
  // 类型标识：步骤开始
  type: z.literal("step-start"),
  // 步骤开始时的代码快照标识（可选）
  snapshot: z.string().optional(),
}).meta({
  ref: "StepStartPart",
})
export type StepStartPart = z.infer<typeof StepStartPart>

export const StepFinishPart = PartBase.extend({
  // 类型标识：步骤结束
  type: z.literal("step-finish"),
  // 结束原因（如 "stop"、"tool-calls"、"length" 等）
  reason: z.string(),
  // 步骤结束时的代码快照标识（可选）
  snapshot: z.string().optional(),
  // 该步骤的费用
  cost: z.number(),
  // 该步骤的 token 使用量
  tokens: z.object({
    // 总 token 数（可选）
    total: z.number().optional(),
    // 输入 token 数（不含缓存）
    input: z.number(),
    // 输出 token 数（不含推理）
    output: z.number(),
    // 推理/思考 token 数
    reasoning: z.number(),
    // 缓存 token 信息
    cache: z.object({
      // 缓存读取 token 数
      read: z.number(),
      // 缓存写入 token 数
      write: z.number(),
    }),
  }),
}).meta({
  ref: "StepFinishPart",
})
export type StepFinishPart = z.infer<typeof StepFinishPart>

export const ToolStatePending = z
  .object({
    // 状态：等待执行
    status: z.literal("pending"),
    // 工具调用的输入参数
    input: z.record(z.string(), z.any()),
    // 原始输入的 JSON 字符串
    raw: z.string(),
  })
  .meta({
    ref: "ToolStatePending",
  })

export type ToolStatePending = z.infer<typeof ToolStatePending>

export const ToolStateRunning = z
  .object({
    // 状态：执行中
    status: z.literal("running"),
    // 工具调用的输入参数
    input: z.record(z.string(), z.any()),
    // 工具显示标题（可选），如 "Reading file..."
    title: z.string().optional(),
    // 运行时元数据（可选），如实时输出内容等
    metadata: z.record(z.string(), z.any()).optional(),
    // 执行时间
    time: z.object({
      // 开始时间（毫秒时间戳）
      start: z.number(),
    }),
  })
  .meta({
    ref: "ToolStateRunning",
  })
export type ToolStateRunning = z.infer<typeof ToolStateRunning>

export const ToolStateCompleted = z
  .object({
    // 状态：执行完成
    status: z.literal("completed"),
    // 工具调用的输入参数
    input: z.record(z.string(), z.any()),
    // 工具的文本输出结果
    output: z.string(),
    // 工具显示标题
    title: z.string(),
    // 执行结果的元数据（如文件路径、是否截断等）
    metadata: z.record(z.string(), z.any()),
    // 执行时间
    time: z.object({
      // 开始时间（毫秒时间戳）
      start: z.number(),
      // 结束时间（毫秒时间戳）
      end: z.number(),
      // 压缩时间（可选，上下文压缩时清除输出后设置）
      compacted: z.number().optional(),
    }),
    // 附件列表（可选），如工具返回的图片等文件
    attachments: FilePart.array().optional(),
  })
  .meta({
    ref: "ToolStateCompleted",
  })
export type ToolStateCompleted = z.infer<typeof ToolStateCompleted>

export const ToolStateError = z
  .object({
    // 状态：执行出错
    status: z.literal("error"),
    // 工具调用的输入参数
    input: z.record(z.string(), z.any()),
    // 错误信息
    error: z.string(),
    // 错误相关的元数据（可选），如被中断时的部分输出等
    metadata: z.record(z.string(), z.any()).optional(),
    // 执行时间
    time: z.object({
      // 开始时间（毫秒时间戳）
      start: z.number(),
      // 结束时间（毫秒时间戳）
      end: z.number(),
    }),
  })
  .meta({
    ref: "ToolStateError",
  })
export type ToolStateError = z.infer<typeof ToolStateError>

// 工具执行状态的联合类型：pending(等待) -> running(执行中) -> completed(完成) / error(出错)
export const ToolState = z
  .discriminatedUnion("status", [ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError])
  .meta({
    ref: "ToolState",
  })

export const ToolPart = PartBase.extend({
  // 类型标识：工具调用
  type: z.literal("tool"),
  // 工具调用的唯一 ID，用于关联请求和响应
  callID: z.string(),
  // 工具名称，如 "bash"、"read"、"edit"、"grep" 等
  tool: z.string(),
  // 工具执行状态（pending -> running -> completed/error）
  state: ToolState,
  // 工具调用级别的元数据（可选），如 providerExecuted 标记等
  metadata: z.record(z.string(), z.any()).optional(),
}).meta({
  ref: "ToolPart",
})
export type ToolPart = z.infer<typeof ToolPart>

const Base = z.object({
  id: MessageID.zod,
  sessionID: SessionID.zod,
})

export const User = Base.extend({
  role: z.literal("user"),
  time: z.object({
    created: z.number(),
  }),
  format: Format.optional(),
  summary: z
    .object({
      title: z.string().optional(),
      body: z.string().optional(),
      diffs: Snapshot.FileDiff.array(),
    })
    .optional(),
  agent: z.string(),
  model: z.object({
    providerID: ProviderID.zod,
    modelID: ModelID.zod,
    variant: z.string().optional(),
  }),
  system: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
}).meta({
  ref: "UserMessage",
})
export type User = z.infer<typeof User>

// 消息内容部分的联合类型，按 type 字段区分：
// text(文本) | subtask(子任务) | reasoning(推理) | file(文件) | tool(工具调用)
// step-start(步骤开始) | step-finish(步骤结束) | snapshot(快照) | patch(补丁)
// agent(Agent引用) | retry(重试) | compaction(上下文压缩)
export const Part = z
  .discriminatedUnion("type", [
    TextPart,
    SubtaskPart,
    ReasoningPart,
    FilePart,
    ToolPart,
    StepStartPart,
    StepFinishPart,
    SnapshotPart,
    PatchPart,
    AgentPart,
    RetryPart,
    CompactionPart,
  ])
  .meta({
    ref: "Part",
  })
export type Part = z.infer<typeof Part>

export const Assistant = Base.extend({
  role: z.literal("assistant"),
  time: z.object({
    created: z.number(),
    completed: z.number().optional(),
  }),
  error: z
    .discriminatedUnion("name", [
      AuthError.Schema,
      NamedError.Unknown.Schema,
      OutputLengthError.Schema,
      AbortedError.Schema,
      StructuredOutputError.Schema,
      ContextOverflowError.Schema,
      APIError.Schema,
    ])
    .optional(),
  parentID: MessageID.zod,
  modelID: ModelID.zod,
  providerID: ProviderID.zod,
  /**
   * @deprecated
   */
  mode: z.string(),
  agent: z.string(),
  path: z.object({
    cwd: z.string(),
    root: z.string(),
  }),
  summary: z.boolean().optional(),
  cost: z.number(),
  tokens: z.object({
    total: z.number().optional(),
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({
      read: z.number(),
      write: z.number(),
    }),
  }),
  structured: z.any().optional(),
  variant: z.string().optional(),
  finish: z.string().optional(),
}).meta({
  ref: "AssistantMessage",
})
export type Assistant = z.infer<typeof Assistant>

export const Info = z.discriminatedUnion("role", [User, Assistant]).meta({
  ref: "Message",
})
export type Info = z.infer<typeof Info>

export const Event = {
  Updated: SyncEvent.define({
    type: "message.updated",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      info: Info,
    }),
  }),
  Removed: SyncEvent.define({
    type: "message.removed",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
    }),
  }),
  PartUpdated: SyncEvent.define({
    type: "message.part.updated",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      part: Part,
      time: z.number(),
    }),
  }),
  PartDelta: BusEvent.define(
    "message.part.delta",
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      partID: PartID.zod,
      field: z.string(),
      delta: z.string(),
    }),
  ),
  PartRemoved: SyncEvent.define({
    type: "message.part.removed",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      partID: PartID.zod,
    }),
  }),
}

export const WithParts = z.object({
  info: Info,
  parts: z.array(Part),
})
export type WithParts = z.infer<typeof WithParts>

const Cursor = z.object({
  id: MessageID.zod,
  time: z.number(),
})
type Cursor = z.infer<typeof Cursor>

export const cursor = {
  encode(input: Cursor) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  },
  decode(input: string) {
    return Cursor.parse(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

const info = (row: typeof MessageTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  }) as Info

const part = (row: typeof PartTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  }) as Part

const older = (row: Cursor) =>
  or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))

function hydrate(rows: (typeof MessageTable.$inferSelect)[]) {
  const ids = rows.map((row) => row.id)
  const partByMessage = new Map<string, Part[]>()
  if (ids.length > 0) {
    const partRows = Database.use((db) =>
      db
        .select()
        .from(PartTable)
        .where(inArray(PartTable.message_id, ids))
        .orderBy(PartTable.message_id, PartTable.id)
        .all(),
    )
    for (const row of partRows) {
      const next = part(row)
      const list = partByMessage.get(row.message_id)
      if (list) list.push(next)
      else partByMessage.set(row.message_id, [next])
    }
  }

  return rows.map((row) => ({
    info: info(row),
    parts: partByMessage.get(row.id) ?? [],
  }))
}

function providerMeta(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  const { providerExecuted: _, ...rest } = metadata
  return Object.keys(rest).length > 0 ? rest : undefined
}

export const toModelMessagesEffect = Effect.fnUntraced(function* (
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean },
) {
  const result: UIMessage[] = []
  const toolNames = new Set<string>()
  // Track media from tool results that need to be injected as user messages
  // for providers that don't support media in tool results.
  //
  // OpenAI-compatible APIs only support string content in tool results, so we need
  // to extract media and inject as user messages. Other SDKs (anthropic, google,
  // bedrock) handle type: "content" with media parts natively.
  //
  // Only apply this workaround if the model actually supports image input -
  // otherwise there's no point extracting images.
  const supportsMediaInToolResults = (() => {
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/openai") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") return true
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
    if (model.api.npm === "@ai-sdk/google") {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  })()

  const toModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => {
    const output = options.output
    if (typeof output === "string") {
      return { type: "text", value: output }
    }

    if (typeof output === "object") {
      const outputObject = output as {
        text: string
        attachments?: Array<{ mime: string; url: string }>
      }
      const attachments = (outputObject.attachments ?? []).filter((attachment) => {
        return attachment.url.startsWith("data:") && attachment.url.includes(",")
      })

      return {
        type: "content",
        value: [
          { type: "text", text: outputObject.text },
          ...attachments.map((attachment) => ({
            type: "media",
            mediaType: attachment.mime,
            data: iife(() => {
              const commaIndex = attachment.url.indexOf(",")
              return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
            }),
          })),
        ],
      }
    }

    return { type: "json", value: output as never }
  }

  for (const msg of input) {
    if (msg.parts.length === 0) continue

    if (msg.info.role === "user") {
      const userMessage: UIMessage = {
        id: msg.info.id,
        role: "user",
        parts: [],
      }
      result.push(userMessage)
      for (const part of msg.parts) {
        if (part.type === "text" && !part.ignored)
          userMessage.parts.push({
            type: "text",
            text: part.text,
          })
        // text/plain and directory files are converted into text parts, ignore them
        if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
          if (options?.stripMedia && isMedia(part.mime)) {
            userMessage.parts.push({
              type: "text",
              text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
            })
          } else {
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })
          }
        }

        if (part.type === "compaction") {
          userMessage.parts.push({
            type: "text",
            text: "What did we do so far?",
          })
        }
        if (part.type === "subtask") {
          userMessage.parts.push({
            type: "text",
            text: "The following tool was executed by the user",
          })
        }
      }
    }

    if (msg.info.role === "assistant") {
      const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      const media: Array<{ mime: string; url: string }> = []

      if (
        msg.info.error &&
        !(
          AbortedError.isInstance(msg.info.error) &&
          msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
        )
      ) {
        continue
      }
      const assistantMessage: UIMessage = {
        id: msg.info.id,
        role: "assistant",
        parts: [],
      }
      for (const part of msg.parts) {
        if (part.type === "text")
          assistantMessage.parts.push({
            type: "text",
            text: part.text,
            ...(differentModel ? {} : { providerMetadata: part.metadata }),
          })
        if (part.type === "step-start")
          assistantMessage.parts.push({
            type: "step-start",
          })
        if (part.type === "tool") {
          toolNames.add(part.tool)
          if (part.state.status === "completed") {
            const outputText = part.state.time.compacted ? "[Old tool result content cleared]" : part.state.output
            const attachments = part.state.time.compacted || options?.stripMedia ? [] : (part.state.attachments ?? [])

            // For providers that don't support media in tool results, extract media files
            // (images, PDFs) to be sent as a separate user message
            const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
            const nonMediaAttachments = attachments.filter((a) => !isMedia(a.mime))
            if (!supportsMediaInToolResults && mediaAttachments.length > 0) {
              media.push(...mediaAttachments)
            }
            const finalAttachments = supportsMediaInToolResults ? attachments : nonMediaAttachments

            const output =
              finalAttachments.length > 0
                ? {
                    text: outputText,
                    attachments: finalAttachments,
                  }
                : outputText

            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output,
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
          }
          if (part.state.status === "error") {
            const output = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
            if (typeof output === "string") {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            } else {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            }
          }
          // Handle pending/running tool calls to prevent dangling tool_use blocks
          // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
          if (part.state.status === "pending" || part.state.status === "running")
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: "[Tool execution was interrupted]",
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
        }
        if (part.type === "reasoning") {
          assistantMessage.parts.push({
            type: "reasoning",
            text: part.text,
            ...(differentModel ? {} : { providerMetadata: part.metadata }),
          })
        }
      }
      if (assistantMessage.parts.length > 0) {
        result.push(assistantMessage)
        // Inject pending media as a user message for providers that don't support
        // media (images, PDFs) in tool results
        if (media.length > 0) {
          result.push({
            id: MessageID.ascending(),
            role: "user",
            parts: [
              {
                type: "text" as const,
                text: SYNTHETIC_ATTACHMENT_PROMPT,
              },
              ...media.map((attachment) => ({
                type: "file" as const,
                url: attachment.url,
                mediaType: attachment.mime,
              })),
            ],
          })
        }
      }
    }
  }

  const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

  return yield* Effect.promise(() =>
    convertToModelMessages(
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      },
    ),
  )
})

export function toModelMessages(
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean },
): Promise<ModelMessage[]> {
  return Effect.runPromise(toModelMessagesEffect(input, model, options).pipe(Effect.provide(EffectLogger.layer)))
}

export function page(input: { sessionID: SessionID; limit: number; before?: string }) {
  const before = input.before ? cursor.decode(input.before) : undefined
  const where = before
    ? and(eq(MessageTable.session_id, input.sessionID), older(before))
    : eq(MessageTable.session_id, input.sessionID)
  const rows = Database.use((db) =>
    db
      .select()
      .from(MessageTable)
      .where(where)
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(input.limit + 1)
      .all(),
  )
  if (rows.length === 0) {
    const row = Database.use((db) =>
      db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get(),
    )
    if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    return {
      items: [] as WithParts[],
      more: false,
    }
  }

  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  const items = hydrate(slice)
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
  }
}

export function* stream(sessionID: SessionID) {
  const size = 50
  let before: string | undefined
  while (true) {
    const next = page({ sessionID, limit: size, before })
    if (next.items.length === 0) break
    for (let i = next.items.length - 1; i >= 0; i--) {
      yield next.items[i]
    }
    if (!next.more || !next.cursor) break
    before = next.cursor
  }
}

export function parts(message_id: MessageID) {
  const rows = Database.use((db) =>
    db.select().from(PartTable).where(eq(PartTable.message_id, message_id)).orderBy(PartTable.id).all(),
  )
  return rows.map(
    (row) =>
      ({
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      }) as Part,
  )
}

export function get(input: { sessionID: SessionID; messageID: MessageID }): WithParts {
  const row = Database.use((db) =>
    db
      .select()
      .from(MessageTable)
      .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
      .get(),
  )
  if (!row) throw new NotFoundError({ message: `Message not found: ${input.messageID}` })
  return {
    info: info(row),
    parts: parts(input.messageID),
  }
}

export function filterCompacted(msgs: Iterable<WithParts>) {
  const result = [] as WithParts[]
  const completed = new Set<string>()
  let retain: MessageID | undefined
  for (const msg of msgs) {
    result.push(msg)
    if (retain) {
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item): item is CompactionPart => item.type === "compaction")
      if (!part) continue
      if (!part.tail_start_id) break
      retain = part.tail_start_id
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id) && msg.parts.some((part) => part.type === "compaction"))
      break
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
      completed.add(msg.info.parentID)
  }
  result.reverse()
  return result
}

export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
  return filterCompacted(stream(sessionID))
})

export function fromError(
  e: unknown,
  ctx: { providerID: ProviderID; aborted?: boolean },
): NonNullable<Assistant["error"]> {
  switch (true) {
    case e instanceof DOMException && e.name === "AbortError":
      return new AbortedError(
        { message: e.message },
        {
          cause: e,
        },
      ).toObject()
    case OutputLengthError.isInstance(e):
      return e
    case LoadAPIKeyError.isInstance(e):
      return new AuthError(
        {
          providerID: ctx.providerID,
          message: e.message,
        },
        { cause: e },
      ).toObject()
    case (e as SystemError)?.code === "ECONNRESET":
      return new APIError(
        {
          message: "Connection reset by server",
          isRetryable: true,
          metadata: {
            code: (e as SystemError).code ?? "",
            syscall: (e as SystemError).syscall ?? "",
            message: (e as SystemError).message ?? "",
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
      if (ctx.aborted) {
        return new AbortedError({ message: e.message }, { cause: e }).toObject()
      }
      return new APIError(
        {
          message: "Response decompression failed",
          isRetryable: true,
          metadata: {
            code: (e as FetchDecompressionError).code,
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    case APICallError.isInstance(e):
      const parsed = ProviderError.parseAPICallError({
        providerID: ctx.providerID,
        error: e,
      })
      if (parsed.type === "context_overflow") {
        return new ContextOverflowError(
          {
            message: parsed.message,
            responseBody: parsed.responseBody,
          },
          { cause: e },
        ).toObject()
      }

      return new APIError(
        {
          message: parsed.message,
          statusCode: parsed.statusCode,
          isRetryable: parsed.isRetryable,
          responseHeaders: parsed.responseHeaders,
          responseBody: parsed.responseBody,
          metadata: parsed.metadata,
        },
        { cause: e },
      ).toObject()
    case e instanceof Error:
      return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    default:
      try {
        const parsed = ProviderError.parseStreamError(e)
        if (parsed) {
          if (parsed.type === "context_overflow") {
            return new ContextOverflowError(
              {
                message: parsed.message,
                responseBody: parsed.responseBody,
              },
              { cause: e },
            ).toObject()
          }
          return new APIError(
            {
              message: parsed.message,
              isRetryable: parsed.isRetryable,
              responseBody: parsed.responseBody,
            },
            {
              cause: e,
            },
          ).toObject()
        }
      } catch {}
      return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
  }
}

export * as MessageV2 from "./message-v2"
