- 要重新生成 JavaScript SDK，运行 `./packages/sdk/js/script/build.ts`。
- 适用时务必使用并行工具。
- 本仓库的默认分支是 `dev`。
- 本地 `main` 引用可能不存在；使用 `dev` 或 `origin/dev` 进行差异比较。
- 优先自动化：除非因缺少信息或安全性/不可逆性而受阻，否则无需确认直接执行请求的操作。

## 代码风格指南

### 通用原则

- 除非需要可组合或可复用，否则将逻辑保持在一个函数中
- 尽可能避免使用 `try`/`catch`
- 避免使用 `any` 类型
- 尽可能使用 Bun API，如 `Bun.file()`
- 尽可能依赖类型推断；除非导出或清晰度需要，否则避免显式类型注解或接口
- 优先使用函数式数组方法（flatMap、filter、map）而非 for 循环；在 filter 上使用类型守卫以保持下游类型推断
- 在 `src/config` 中，添加新的配置模块时遵循文件顶部现有的自导出模式（例如 `export * as ConfigAgent from "./agent"`）

当值仅使用一次时，通过内联来减少变量总数。

```ts
// 好
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// 不好
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### 解构

避免不必要的解构。使用点号表示法以保留上下文。

```ts
// 好
obj.a
obj.b

// 不好
const { a, b } = obj
```

### 变量

优先使用 `const` 而非 `let`。使用三元表达式或提前返回代替重新赋值。

```ts
// 好
const foo = condition ? 1 : 2

// 不好
let foo
if (condition) foo = 1
else foo = 2
```

### 控制流

避免 `else` 语句。优先使用提前返回。

```ts
// 好
function foo() {
  if (condition) return 1
  return 2
}

// 不好
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema 定义（Drizzle）

字段名使用 snake_case，这样列名无需重新定义为字符串。

```ts
// 好
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// 不好
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## 测试

- 尽可能避免使用 mock
- 测试实际实现，不要在测试中重复逻辑
- 测试不能从仓库根目录运行（守卫：`do-not-run-tests-from-root`）；从包目录运行，如 `packages/opencode`。

## 类型检查

- 始终从包目录（如 `packages/opencode`）运行 `bun typecheck`，不要直接使用 `tsc`。


<claude-mem-context>
# Memory Context

# [opencode] recent context, 2026-05-08 10:33am GMT+8

No previous sessions found.
</claude-mem-context>