export interface AllowedText {
  readonly file: string
  readonly text: string
  readonly reason: string
}

export const coreAllowed: readonly AllowedText[] = []
