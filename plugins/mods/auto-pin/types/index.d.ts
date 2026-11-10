// Whether a new session still waits to be pinned
export type IsPending = boolean

declare module 'claude-code' {
  interface PluginState {
    'auto-pin': { isPending: IsPending }
  }
}
