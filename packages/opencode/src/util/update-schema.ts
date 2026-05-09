import z from "zod"

//Zod object schema 的所有字段变为"可选且可空"
export function updateSchema<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const next = {} as {
    [K in keyof T]: z.ZodOptional<z.ZodNullable<T[K]>>
  }

  for (const [k, v] of Object.entries(schema.required().shape) as [keyof T & string, z.ZodTypeAny][]) {
    next[k] = v.nullable() as unknown as (typeof next)[typeof k]
  }

  return z.object(next)
}
