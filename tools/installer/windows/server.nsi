; ARTEPOOL-Server-Setup (M6.2 part F): the server PC's installer.
;
; Built by `pnpm build:installer` with /DVERSION, /DSTAGE (the staged files, laid out as in
; C:\Program Files\ARTEPOOL) and /DOUTFILE. The heavy lifting is done by the programs it installs,
; each step tested on its own:
;   artepool-svc secrets init   the six secrets, DPAPI-protected (decision 0103)
;   artepool-svc config init    C:\ProgramData\ARTEPOOL\config\server.json
;   artepool-svc run install    database, services, certificates, firewall (apps/server/src/cli/install)
; Every edition of Windows 10 22H2 / 11 (decision 0106): only Windows' own tools are used.
; The data in C:\ProgramData\ARTEPOOL is never removed by the uninstaller (decision 0103).

Unicode true
ManifestSupportedOS all
RequestExecutionLevel admin
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"

!ifndef VERSION
  !error "VERSION is required (/DVERSION=x.y.z)"
!endif
!ifndef STAGE
  !error "STAGE is required (/DSTAGE=folder)"
!endif
!ifndef OUTFILE
  !define OUTFILE "ARTEPOOL-Server-Setup-${VERSION}.exe"
!endif

!define PRODUCT "ARTEPOOL ERP Server"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ARTEPOOL-Server"
!define MINIMUM_BUILD 19045
!define SERVER_PORT 3100
!define APP_EXE "$PROGRAMFILES64\ARTEPOOL ERP\artepool-erp.exe"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\ARTEPOOL"
BrandingText "ARTEPOOL ERP ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT}"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileDescription" "ARTEPOOL ERP server setup"
VIAddVersionKey /LANG=1033 "LegalCopyright" "ARTEPOOL"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION OpenApp
!define MUI_FINISHPAGE_RUN_TEXT "$(OpenAppText)"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Arabic"
!insertmacro MUI_LANGUAGE "English"

LangString OpenAppText ${LANG_ARABIC} "افتح آرتيبول لإكمال الإعداد الأول"
LangString OpenAppText ${LANG_ENGLISH} "Open ARTEPOOL to finish the first-run setup"
LangString Not64 ${LANG_ARABIC} "آرتيبول يحتاج Windows 64-bit."
LangString Not64 ${LANG_ENGLISH} "ARTEPOOL needs a 64-bit Windows."
LangString OldWindows ${LANG_ARABIC} "آرتيبول يحتاج Windows 10 (22H2) أو Windows 11."
LangString OldWindows ${LANG_ENGLISH} "ARTEPOOL needs Windows 10 (22H2) or Windows 11."
LangString Installed ${LANG_ARABIC} "آرتيبول متسطّب فعلًا على الجهاز ده (بياناته موجودة في C:\ProgramData\ARTEPOOL). مفيش حاجة اتغيرت."
LangString Installed ${LANG_ENGLISH} "ARTEPOOL is already installed on this PC (its data is in C:\ProgramData\ARTEPOOL). Nothing was changed."
LangString StepFailed ${LANG_ARABIC} "التسطيب ما كملش. السبب مكتوب في سجل التسطيب في C:\ProgramData\ARTEPOOL\logs\install. ابعته للدعم الفني."
LangString StepFailed ${LANG_ENGLISH} "The installation did not finish. The reason is in the install log in C:\ProgramData\ARTEPOOL\logs\install. Send it to support."
LangString EmergencyTool ${LANG_ARABIC} "آرتيبول - أداة الطوارئ"
LangString EmergencyTool ${LANG_ENGLISH} "ARTEPOOL - Emergency tool"

Var DataDir
Var LogFile

; One line in the setup's own log (the install program keeps a fuller one beside it).
!macro Log text
  DetailPrint "${text}"
  ${If} $LogFile != ""
    FileWrite $LogFile "${text}$\r$\n"
  ${EndIf}
!macroend

!macro OpenLog prefix
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  CreateDirectory "$DataDir\logs\install"
  FileOpen $LogFile "$DataDir\logs\install\${prefix}-$2$1$0-$4$5$6.log" a
  !insertmacro Log "ARTEPOOL ${prefix} ${VERSION} - $2-$1-$0 $4:$5:$6"
!macroend

; Runs one step; on failure, logs the exit code, tells why, and stops with that code.
!macro Step title command
  !insertmacro Log "${title}"
  nsExec::ExecToLog '${command}'
  Pop $0
  ${If} $0 != 0
    !insertmacro Log "FAILED (${title}): exit code $0"
    FileClose $LogFile
    MessageBox MB_ICONSTOP|MB_OK "$(StepFailed)" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend

Function .onInit
  SetShellVarContext all
  StrCpy $DataDir "$COMMONAPPDATA\ARTEPOOL"
  ${IfNot} ${Silent}
    !insertmacro MUI_LANGDLL_DISPLAY
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP|MB_OK "$(Not64)" /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
  ${WinVerGetBuild} $0
  ${If} $0 < ${MINIMUM_BUILD}
    MessageBox MB_ICONSTOP|MB_OK "$(OldWindows)" /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
  ${If} ${FileExists} "$DataDir\pgdata\PG_VERSION"
    MessageBox MB_ICONSTOP|MB_OK "$(Installed)" /SD IDOK
    SetErrorLevel 4
    Abort
  ${EndIf}
  SetRegView 64
FunctionEnd

Section "ARTEPOOL ERP Server" SecServer
  SectionIn RO
  SetShellVarContext all
  !insertmacro OpenLog "setup"
  ${WinVerGetBuild} $0
  !insertmacro Log "Windows build $0"

  !insertmacro Log "Copying the programs to $INSTDIR"
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "ARTEPOOL"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1

  CreateDirectory "$DataDir"
  !insertmacro Step "The protected secrets" '"$INSTDIR\artepool-svc.exe" --data "$DataDir" secrets init'
  !insertmacro Step "The settings file" '"$INSTDIR\artepool-svc.exe" --data "$DataDir" config init --port ${SERVER_PORT}'
  !insertmacro Step "The database, the services and the certificates" '"$INSTDIR\artepool-svc.exe" --data "$DataDir" run install'

  !insertmacro Log "The ARTEPOOL app"
  ExecWait '"$INSTDIR\app\artepool-erp-setup.exe" /S' $0
  ${If} $0 != 0
    !insertmacro Log "FAILED (the ARTEPOOL app): exit code $0"
    FileClose $LogFile
    MessageBox MB_ICONSTOP|MB_OK "$(StepFailed)" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}

  ${If} ${FileExists} "$INSTDIR\artepool-emergency.exe"
    CreateShortcut "$SMPROGRAMS\$(EmergencyTool).lnk" "$INSTDIR\artepool-emergency.exe"
  ${EndIf}

  !insertmacro Log "Installed."
  FileClose $LogFile
SectionEnd

Function OpenApp
  ; The installer runs as administrator, so the app can read the first-run setup files.
  Exec '"${APP_EXE}"'
FunctionEnd

Function un.onInit
  SetShellVarContext all
  StrCpy $DataDir "$COMMONAPPDATA\ARTEPOOL"
  SetRegView 64
FunctionEnd

!macro UnStep title command
  !insertmacro Log "${title}"
  nsExec::ExecToLog '${command}'
  Pop $0
  !insertmacro Log "  exit code $0"
!macroend

Section "Uninstall"
  SetShellVarContext all
  !insertmacro OpenLog "uninstall"
  !insertmacro Log "The data in $DataDir is kept (database, backups, secrets, settings)."

  !insertmacro UnStep "Stop ArtepoolBackup" '"$SYSDIR\sc.exe" stop ArtepoolBackup'
  !insertmacro UnStep "Stop ArtepoolServer" '"$SYSDIR\sc.exe" stop ArtepoolServer'
  Sleep 3000
  !insertmacro UnStep "Remove ArtepoolBackup" '"$INSTDIR\winsw\ArtepoolBackup.exe" uninstall'
  !insertmacro UnStep "Remove ArtepoolServer" '"$INSTDIR\winsw\ArtepoolServer.exe" uninstall'
  !insertmacro UnStep "Stop ArtepoolDatabase" '"$SYSDIR\sc.exe" stop ArtepoolDatabase'
  Sleep 5000
  !insertmacro UnStep "Remove ArtepoolDatabase" '"$INSTDIR\pgsql\bin\pg_ctl.exe" unregister -N ArtepoolDatabase'
  !insertmacro UnStep "Remove the firewall rule" '"$SYSDIR\netsh.exe" advfirewall firewall delete rule "name=ARTEPOOL Server"'

  Delete "$SMPROGRAMS\$(EmergencyTool).lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  !insertmacro Log "Uninstalled. The ARTEPOOL app has its own entry in Apps."
  FileClose $LogFile
SectionEnd
