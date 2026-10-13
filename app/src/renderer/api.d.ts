export interface LoadPayload { markdown: string; baseUrl: string; color: string }
export interface NoteCard { id: string; color: string; time: string; preview: string }
export interface SettingsView {
  serverUrl: string; user: string; folder: string; hasPassword: boolean
  startWithLogin: boolean; startMinimized: boolean; version: string; loginLabel: string
}

declare global {
  interface Window {
    api: {
      platform: string
      sticky: {
        init(): Promise<LoadPayload | null>
        changed(markdown: string): void
        pasteImage(data: Uint8Array, mime: string, name: string): Promise<{ src?: string; error?: string }>
        openLink(href: string): void
        newNote(): void
        menu(): void
        close(): void
        onLoad(cb: (p: LoadPayload) => void): void
        onColor(cb: (color: string) => void): void
      }
      list: {
        notes(query: string): Promise<NoteCard[]>
        open(id: string): void
        newNote(): void
        remove(id: string): void
        settings(): void
        close(): void
        onChanged(cb: () => void): void
      }
      settings: {
        get(): Promise<SettingsView>
        save(p: object): Promise<{ ok: boolean; message: string }>
      }
      status(): Promise<string>
      onStatus(cb: (s: string) => void): void
      syncNow(): void
    }
  }
}
