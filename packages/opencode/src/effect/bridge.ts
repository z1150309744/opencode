import { Effect, Fiber } from "effect"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { Instance, type InstanceContext } from "@/project/instance"
import type { WorkspaceID } from "@/control-plane/schema"
import { LocalContext } from "@/util"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { attachWith } from "./run-service"

export interface Shape {
  readonly promise: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>
  readonly fork: <A, E, R>(effect: Effect.Effect<A, E, R>) => Fiber.Fiber<A, E>
}

function restore<R>(instance: InstanceContext | undefined, workspace: WorkspaceID | undefined, fn: () => R): R {
  if (instance && workspace !== undefined) {
    return WorkspaceContext.restore(workspace, () => Instance.restore(instance, fn))
  }
  if (instance) return Instance.restore(instance, fn)
  if (workspace !== undefined) return WorkspaceContext.restore(workspace, fn)
  return fn()
}

/**
 * 使用场景：当你需要在一个回调、事件处理器或第三方库的非 Effect 代码中执行 Effect 时，
 * 先在 Effect 上下文中调用 EffectBridge.make() 捕获当前环境，之后就可以在任意位置通过
 *   bridge.promise(effect) 或 bridge.fork(effect) 来运行 Effect，且这些 Effect
 *   会自动携带之前捕获的所有服务和上下文
 */
export function make(): Effect.Effect<Shape> {
  return Effect.gen(function* () {
    const ctx = yield* Effect.context() //捕获当前完整的 Effect 上下文（所有已提供的服务层）
    const value = yield* InstanceRef
    const instance =
      value ??
      (() => {
        try {
          return Instance.current
        } catch (err) {
          if (!(err instanceof LocalContext.NotFound)) throw err
        }
      })()
    const workspace = (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID
    const attach = <A, E, R>(effect: Effect.Effect<A, E, R>) => attachWith(effect, { instance, workspace })
    const wrap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      attach(effect).pipe(Effect.provide(ctx)) as Effect.Effect<A, E, never>

    return {
      promise: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        restore(instance, workspace, () => Effect.runPromise(wrap(effect))),
      fork: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        restore(instance, workspace, () => Effect.runFork(wrap(effect))),
    } satisfies Shape
  })
}
