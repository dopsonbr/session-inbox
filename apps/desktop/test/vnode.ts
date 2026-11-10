/** Helpers for view tests over `inertHtml` vnodes (no runtime, handlers never fire). */
import { type HtmlBuilder, inertHtml } from "foldkit/html"
import type { Message } from "../src/message.ts"

export const h = inertHtml as unknown as HtmlBuilder<Message>

type VNode = {
  sel?: string
  text?: string
  data?: { props?: Record<string, unknown>; attrs?: Record<string, unknown> }
  children?: ReadonlyArray<unknown>
}

const childrenOf = (node: unknown): ReadonlyArray<unknown> => {
  if (Array.isArray(node)) return node
  if (node === null || typeof node !== "object") return []
  return (node as VNode).children ?? []
}

/** All text in a vnode tree (or list of trees), in order. */
export const textOf = (node: unknown): string => {
  if (node === null || node === undefined) return ""
  if (typeof node === "string") return node
  const text = Array.isArray(node) ? "" : ((node as VNode).text ?? "")
  return `${typeof text === "string" ? text : ""}${childrenOf(node).map(textOf).join("")}`
}

/** Every element whose tag is `sel` (e.g. "a", "pre", "textarea"). */
export const findAll = (node: unknown, sel: string): ReadonlyArray<VNode> => {
  if (node === null || typeof node !== "object") return []
  const self = !Array.isArray(node) && (node as VNode).sel === sel ? [node as VNode] : []
  return [...self, ...childrenOf(node).flatMap((child) => findAll(child, sel))]
}

/** A prop or attribute of an element (Foldkit puts most in `props`). */
export const attrOf = (node: VNode, name: string): unknown =>
  node.data?.props?.[name] ?? node.data?.attrs?.[name]
