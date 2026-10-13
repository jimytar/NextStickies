import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { safeStorage } from 'electron'

/** Nextcloud connection + app preferences. Password is encrypted with the OS keystore (DPAPI / libsecret). */
export interface Settings {
  ServerUrl: string
  User: string
  Folder: string
  EncryptedPassword?: string
  /** 1.x (WPF) DPAPI blob; migrated to EncryptedPassword on first start. */
  ProtectedPassword?: string
  StartMinimized: boolean
  /** Ask before deleting a note ("Don't ask me again" turns it off). */
  ConfirmDelete: boolean
}

const defaults: Settings = { ServerUrl: '', User: '', Folder: 'Notes', StartMinimized: false, ConfirmDelete: true }

export function loadSettings(file: string): Settings {
  const s: Settings = { ...defaults, ...(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}) }
  if (s.ProtectedPassword && !s.EncryptedPassword && process.platform === 'win32') {
    try {
      setPassword(s, unprotectDpapi(s.ProtectedPassword))
      delete s.ProtectedPassword
      saveSettings(file, s)
    } catch {
      // leave it; the user can re-enter the password in Settings
    }
  }
  return s
}

export function saveSettings(file: string, s: Settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(s, null, 2))
}

export const isConfigured = (s: Settings) => !!(s.ServerUrl && s.User && s.EncryptedPassword)
/** Identifies the remote folder; when it changes the sync state no longer applies. */
export const remoteKey = (s: Settings) => `${s.ServerUrl.replace(/\/+$/, '')}|${s.User}|${s.Folder.replace(/^\/+|\/+$/g, '')}`

export function getPassword(s: Settings): string {
  return s.EncryptedPassword ? safeStorage.decryptString(Buffer.from(s.EncryptedPassword, 'base64')) : ''
}

export function setPassword(s: Settings, password: string) {
  s.EncryptedPassword = password ? safeStorage.encryptString(password).toString('base64') : undefined
}

/** Decrypts a CurrentUser DPAPI blob written by the 1.x app (input via stdin, never on the command line). */
function unprotectDpapi(blob: string): string {
  const script =
    'Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
    '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,"CurrentUser"))'
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: blob, windowsHide: true })
  return Buffer.from(out.toString().trim(), 'base64').toString('utf8')
}

// ---- Start with Windows / login ---------------------------------------------------------------------------

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_VALUE = 'NextStickies' // also removed by the uninstaller
const linuxAutostart = () => path.join(os.homedir(), '.config', 'autostart', 'nextstickies.desktop')
const oldLinuxAutostart = () => path.join(os.homedir(), '.config', 'autostart', 'nc-sticky-notes.desktop')
/** The AppImage path when running from one (the executable itself lives in a temporary mount). */
const launchPath = () => process.env.APPIMAGE || process.execPath

export function getStartWithLogin(): boolean {
  if (process.platform === 'win32') {
    try {
      execFileSync('reg.exe', ['query', RUN_KEY, '/v', RUN_VALUE], { stdio: 'ignore', windowsHide: true })
      return true
    } catch {
      return false
    }
  }
  return fs.existsSync(linuxAutostart())
}

/** Linux: replaces a pre-rename autostart entry. (Windows: the installer moves the Run value.) */
export function migrateStartWithLogin() {
  if (process.platform === 'win32' || !fs.existsSync(oldLinuxAutostart())) return
  fs.rmSync(oldLinuxAutostart(), { force: true })
  setStartWithLogin(true)
}

export function setStartWithLogin(enabled: boolean) {
  if (process.platform === 'win32') {
    const args = enabled
      ? ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${process.execPath}"`, '/f']
      : ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']
    try {
      execFileSync('reg.exe', args, { stdio: 'ignore', windowsHide: true })
    } catch {
      // deleting a missing value fails; nothing to do
    }
    return
  }
  const file = linuxAutostart()
  if (!enabled) {
    fs.rmSync(file, { force: true })
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=NextStickies\nExec="${launchPath()}"\nIcon=nextstickies\nX-GNOME-Autostart-enabled=true\n`)
}
