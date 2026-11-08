import { Toast as UiToast } from "@foldkit/ui"
import { Schema } from "effect"

/** In-app toasts are for delivery confirmations only; real alerts are native notifications. */
export const ToastPayload = Schema.Struct({
  title: Schema.String,
  description: Schema.String,
})
export type ToastPayload = typeof ToastPayload.Type

export const Toast = UiToast.make(ToastPayload)
