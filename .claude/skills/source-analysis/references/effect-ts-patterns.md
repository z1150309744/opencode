# Effect-TS 模式速查

分析 Effect-TS 代码时的常见模式识别参考。

## 目录

1. [Service 模式](#service-模式)
2. [Effect 组合](#effect-组合)
3. [Layer 系统](#layer-系统)
4. [Scope 与资源管理](#scope-与资源管理)
5. [InstanceState](#instancestate)
6. [Bus 事件系统](#bus-事件系统)
7. [Schema 与错误](#schema-与错误)
8. [并发模式](#并发模式)

---

## Service 模式

### 标准 Service 定义

```typescript
// 1. 接口定义
export interface Interface {
  readonly methodA: (input: A) => Effect.Effect<B>
  readonly methodB: (input: C) => Effect.Effect<D, MyError>
}

// 2. Service 标签
export class Service extends Context.Service<Service, Interface>()("@opencode/ModuleName") {}

// 3. Layer 实现
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // yield* 获取依赖
    const dep = yield* OtherService.Service
    
    // 实现方法
    const methodA = Effect.fn("Module.methodA")(function* (input: A) {
      // ...
    })
    
    return Service.of({ methodA, methodB })
  }),
)

// 4. 默认 Layer（组合依赖）
export const defaultLayer = layer.pipe(
  Layer.provide(Dep1.defaultLayer),
  Layer.provide(Dep2.defaultLayer),
)

// 5. 自重导出
export * as ModuleName from "./module-name"
```

### 识别要点

- `yield* SomeService.Service` = 从上下文获取依赖（依赖注入）
- `Service.of({...})` = 构造 Service 实例
- `Layer.provide` = 声明依赖供给关系
- `defaultLayer` = 包含所有传递依赖的完整 Layer

---

## Effect 组合

### Effect.gen — Generator 风格

```typescript
Effect.gen(function* () {
  const a = yield* effectA        // 执行 Effect，获取结果
  const b = yield* effectB(a)     // 顺序组合
  return combine(a, b)            // 返回值被包装为 Effect
})
```

### Effect.fn — 命名函数

```typescript
// 参与 tracing，调试时可见函数名
const myMethod = Effect.fn("Domain.myMethod")(function* (input: Input) {
  // ...
})

// 不参与 tracing，用于内部辅助
const helper = Effect.fnUntraced(function* (x: number) {
  // ...
})
```

### Effect.fn 尾部管道

```typescript
// Effect.fn 支持在 generator 之后传入管道操作符
const myMethod = Effect.fn("Domain.myMethod")(
  function* (input: Input) { /* ... */ },
  Effect.scoped,                    // 附加 scoped 行为
  Effect.catchAll(handleError),     // 附加错误处理
)
```

### 常见组合操作

| 操作 | 含义 |
|------|------|
| `yield* effect` | 执行并获取结果 |
| `Effect.all([a, b])` | 并行执行 |
| `Effect.forEach(items, fn, { concurrency: "unbounded" })` | 并行遍历 |
| `effect.pipe(Effect.map(f))` | 映射结果 |
| `effect.pipe(Effect.flatMap(f))` | 链式组合 |
| `effect.pipe(Effect.catchAll(f))` | 捕获所有错误 |
| `effect.pipe(Effect.catchCause(f))` | 捕获错误原因（含 defect） |
| `effect.pipe(Effect.orDie)` | 错误转为 defect（不可恢复） |
| `effect.pipe(Effect.ignore)` | 忽略结果和错误 |
| `effect.pipe(Effect.exit)` | 获取 Exit（不抛异常） |
| `effect.pipe(Effect.option)` | 错误变为 None |

---

## Layer 系统

### 依赖关系分析

```
// 从 defaultLayer 可以反推完整依赖树
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(DepA.defaultLayer),     // 直接依赖 A
    Layer.provide(DepB.defaultLayer),     // 直接依赖 B
    Layer.provide(
      Layer.mergeAll(                     // 合并多个依赖
        DepC.defaultLayer,
        DepD.defaultLayer,
      ),
    ),
  ),
)
```

### Layer.suspend

延迟构造 Layer，用于打破循环依赖或延迟副作用。

---

## Scope 与资源管理

### Effect.scoped

```typescript
const fn = Effect.fn("Name")(function* () {
  yield* Effect.addFinalizer(() => cleanup())  // Scope 关闭时执行
  // ... 主逻辑
  return result
}, Effect.scoped)  // 函数返回时关闭 Scope → 触发 finalizer
```

### Effect.acquireRelease

```typescript
const resource = Effect.acquireRelease(
  acquire,                    // 获取资源
  (resource) => release,      // Scope 关闭时释放
)
```

### Effect.forkIn(scope)

```typescript
// v4 中唯一的 fork 方式
const fiber = yield* myEffect.pipe(Effect.forkIn(scope))
```

---

## InstanceState

按项目目录隔离的状态管理，基于 ScopedCache。

```typescript
// 定义状态工厂
const state = yield* InstanceState.make(
  Effect.fn("MyState")(function* () {
    // 每个项目实例执行一次
    // 可在此注册 finalizer 做清理
    yield* Effect.addFinalizer(() => cleanup())
    return initialState
  }),
)

// 获取当前实例的状态
const data = yield* InstanceState.get(state)

// 获取实例上下文
const ctx = yield* InstanceState.context
// ctx.directory — 当前工作目录
// ctx.worktree — git 工作树根
```

---

## Bus 事件系统

进程内发布/订阅机制。

```typescript
// 定义事件
export const Event = {
  Status: BusEvent.define(
    "session.status",                    // 事件名
    z.object({                           // Payload schema
      sessionID: SessionID.zod,
      status: Info,
    }),
  ),
}

// 发布
yield* bus.publish(Event.Status, { sessionID, status })

// 订阅
yield* bus.subscribe(Event.Status, (payload) =>
  Effect.gen(function* () {
    // 处理事件
  }),
)
```

### 事件流向

```
Service A → bus.publish(Event) → Bus → 所有订阅者
                                  |-- Service B (内部逻辑)
                                  |-- Server (WebSocket → 前端)
                                  \-- Plugin (event hook)
```

---

## Schema 与错误

### TaggedErrorClass

```typescript
export class MyError extends Schema.TaggedErrorClass<MyError>()(
  "MyError",
  { message: Schema.String, code: Schema.Number },
) {}

// 在 Effect.gen 中使用
yield* new MyError({ message: "...", code: 404 })
```

### Exit 模式

```typescript
const exit = yield* someEffect.pipe(Effect.exit)
if (Exit.isSuccess(exit)) {
  // exit.value — 成功值
} else {
  // exit.cause — 失败原因
  const error = Cause.squash(exit.cause)  // 提取根因
}
```

---

## 并发模式

| 模式 | 用法 | 场景 |
|------|------|------|
| `Effect.all([a, b])` | 并行执行多个 Effect | 独立任务并行 |
| `Effect.forEach(items, fn, { concurrency: N })` | 受控并行遍历 | 批量处理 |
| `Effect.forkIn(scope)` | fork 到指定 Scope | 后台任务 |
| `Effect.forkScoped` | fork 到当前 Scope | 后台消费者（Scope 关闭时自动中断） |
| `Effect.cached` | 缓存 Effect 结果 | 去重并发调用 |
| `Effect.uninterruptible` | 不可中断区域 | 关键清理逻辑 |
