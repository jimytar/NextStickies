; Per-user installer (no admin): %LOCALAPPDATA%\Programs\NextStickies, Start menu shortcut, Apps & features entry.
; Notes and settings in %APPDATA%\NextStickies are never touched, not even by the uninstaller.
; Replaces a pre-rename "NC Sticky Notes" install (keeping its "Start with Windows" setting); the app itself moves
; the old data folder on first start.
; Build: makensis -DVERSION=1.2.3 -DAPPDIR=<published app dir> -DOUTFILE=<setup.exe> NextStickies.nsi

Unicode true
!include MUI2.nsh

!define APP "NextStickies"
!define EXE "NextStickies.exe"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\NextStickies"
!define RUNKEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define OLDUNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\NcStickyNotes"
!ifndef VERSION
  !define VERSION 0.0.0
!endif

Name "${APP}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\NextStickies"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ManifestDPIAware true

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "${APP} installer"
VIAddVersionKey "LegalCopyright" "MIT License"

!define MUI_ICON "app.ico"
!define MUI_UNICON "app.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; Ask a running instance to save and quit (--exit), then make sure it is gone so files can be replaced.
!macro StopApp
  IfFileExists "$INSTDIR\${EXE}" 0 +3
    ExecWait '"$INSTDIR\${EXE}" --exit'
    Sleep 2000
  nsExec::Exec 'taskkill /f /im ${EXE}'
  Pop $0
!macroend

; Pre-rename install: run its uninstaller (it stops the old app and removes its files, shortcut and Run value).
!macro RemoveOldInstall
  ReadRegStr $1 HKCU "${OLDUNINSTKEY}" "InstallLocation"
  StrCmp $1 "" done_old
    ReadRegStr $2 HKCU "${RUNKEY}" "NcStickyNotes"
    ExecWait '"$1\Uninstall.exe" /S _?=$1'
    RMDir /r "$1"
    DeleteRegKey HKCU "${OLDUNINSTKEY}"
    StrCmp $2 "" done_old
      WriteRegStr HKCU "${RUNKEY}" "NextStickies" '"$INSTDIR\${EXE}"'
  done_old:
!macroend

Section "Install"
  !insertmacro RemoveOldInstall
  !insertmacro StopApp
  RMDir /r "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /r "${APPDIR}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${EXE}"

  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "jimytar"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  !insertmacro StopApp
  Delete "$SMPROGRAMS\${APP}.lnk"
  DeleteRegValue HKCU "${RUNKEY}" "NextStickies"
  DeleteRegKey HKCU "${UNINSTKEY}"
  RMDir /r "$INSTDIR"
SectionEnd
