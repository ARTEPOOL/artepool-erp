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
;
; Over an installed, older version it upgrades instead (decision 0103, M6.2 part G2):
;   1. the new programs go to "ARTEPOOL.new" beside the installed ones;
;   2. artepool-svc run upgrade prepare   checks, services stopped, pre-upgrade backup
;   3. ARTEPOOL -> ARTEPOOL.previous, ARTEPOOL.new -> ARTEPOOL
;   4. artepool-svc run upgrade apply     migrations all or nothing, services, /health
; If 2 fails nothing changed (exit code 5). If 4 fails the previous programs are put back and
; started (exit code 6); the database is unchanged or put back from the pre-upgrade copy.
; The same installer, run by hand from a USB drive or by the automatic updater (decision 0108).
;
; Over data an uninstall kept, with no program installed, it installs again and uses that data
; (part G3): the secrets must open on this PC; no new database, no new CA; `run install --reattach`.

Unicode true
ManifestSupportedOS all
RequestExecutionLevel admin
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"
!include "TextFunc.nsh"
!include "nsDialogs.nsh"

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

OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\ARTEPOOL"
; The CI test upgrades (/DTEST_BUILD) say on every page that they are not for the shop.
!ifdef TEST_BUILD
  Name "${PRODUCT} - TEST"
  BrandingText "ARTEPOOL ERP ${VERSION} - TEST / اختبار"
!else
  Name "${PRODUCT}"
  BrandingText "ARTEPOOL ERP ${VERSION}"
!endif
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT}"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileDescription" "ARTEPOOL ERP server setup"
VIAddVersionKey /LANG=1033 "LegalCopyright" "ARTEPOOL"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION OpenApp
!define MUI_FINISHPAGE_RUN_TEXT "$(OpenAppText)"
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishShow

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.DeleteDataPage un.DeleteDataLeave
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Arabic"
!insertmacro MUI_LANGUAGE "English"

LangString OpenAppText ${LANG_ARABIC} "افتح آرتيبول لإكمال الإعداد الأول"
LangString OpenAppText ${LANG_ENGLISH} "Open ARTEPOOL to finish the first-run setup"
LangString Not64 ${LANG_ARABIC} "آرتيبول يحتاج Windows 64-bit."
LangString Not64 ${LANG_ENGLISH} "ARTEPOOL needs a 64-bit Windows."
LangString OldWindows ${LANG_ARABIC} "آرتيبول يحتاج Windows 10 (22H2) أو Windows 11."
LangString OldWindows ${LANG_ENGLISH} "ARTEPOOL needs Windows 10 (22H2) or Windows 11."
LangString StepFailed ${LANG_ARABIC} "التسطيب ما كملش. السبب مكتوب في سجل التسطيب في C:\ProgramData\ARTEPOOL\logs\install. ابعته للدعم الفني."
LangString StepFailed ${LANG_ENGLISH} "The installation did not finish. The reason is in the install log in C:\ProgramData\ARTEPOOL\logs\install. Send it to support."
LangString NotNewer ${LANG_ARABIC} "النسخة دي مش أحدث من المتسطّبة. مفيش حاجة اتغيرت."
LangString NotNewer ${LANG_ENGLISH} "This version is not newer than the installed one. Nothing was changed."
LangString UpgradeNotDone ${LANG_ARABIC} "التحديث ما اتعملش، ومفيش حاجة اتغيرت. السبب مكتوب تحت وفي سجل التحديث (upgrade-...) في C:\ProgramData\ARTEPOOL\logs\install."
LangString UpgradeNotDone ${LANG_ENGLISH} "The update was not done and nothing was changed. The reason is below and in the update log (upgrade-...) in C:\ProgramData\ARTEPOOL\logs\install."
LangString UpgradeRolledBack ${LANG_ARABIC} "التحديث ما نجحش، فرجّعنا النسخة القديمة وهي شغالة دلوقتي. بياناتك زي ما هي. السبب مكتوب تحت وفي سجل التحديث (upgrade-...) في C:\ProgramData\ARTEPOOL\logs\install، والنسخة الاحتياطية في backups\pre-upgrade."
LangString UpgradeRolledBack ${LANG_ENGLISH} "The update did not succeed, so the previous version was put back and is running. Your data is as it was. The reason is below and in the update log (upgrade-...) in C:\ProgramData\ARTEPOOL\logs\install; the backup is in backups\pre-upgrade."
LangString UpgradeTestVersion ${LANG_ARABIC} "التحديث ما اتعملش، ومفيش حاجة اتغيرت.$\r$\n$\r$\nالجهاز ده اتسطّب عليه قبل كده نسخة تجريبية من اختبارات GitHub، ومينفعش يتحدّث لأي نسخة حقيقية. امسح البيانات (إلغاء التسطيب ← مسح البيانات) وسطّب من جديد."
LangString UpgradeTestVersion ${LANG_ENGLISH} "The update was not done and nothing was changed.$\r$\n$\r$\nThis PC once had a test version from the GitHub tests, so no real version can update it. Delete the data (uninstall → delete the data) and install again."
LangString ReasonLabel ${LANG_ARABIC} "السبب:"
LangString ReasonLabel ${LANG_ENGLISH} "Reason:"
LangString TestBuild ${LANG_ARABIC} "دي نسخة اختبار من اختبارات GitHub، مش للمحل. متسطّبهاش على جهاز فيه بيانات حقيقية: الجهاز بعدها مش هيتحدّث لأي نسخة حقيقية.$\r$\n$\r$\nتكمّل؟"
LangString TestBuild ${LANG_ENGLISH} "This is a test version from the GitHub tests, not for the shop. Never install it on a PC with real data: that PC could then not be updated to any real version.$\r$\n$\r$\nContinue?"
LangString DeleteDataTitle ${LANG_ARABIC} "البيانات"
LangString DeleteDataTitle ${LANG_ENGLISH} "The data"
LangString DeleteDataSub ${LANG_ARABIC} "البيانات بتفضل على الجهاز إلا لو اخترت تمسحها."
LangString DeleteDataSub ${LANG_ENGLISH} "The data stays on this PC unless you choose to delete it."
LangString DeleteDataText ${LANG_ARABIC} "إلغاء التسطيب بيشيل البرنامج بس. قاعدة البيانات والإعدادات بتفضل في C:\ProgramData\ARTEPOOL، ولو سطّبت تاني هتلاقيها زي ما هي.$\r$\n$\r$\nلو عايز تمسح البيانات نهائيًا: علّم على الاختيار ده، وهيطلب منك تكتب DELETE وكلمة سر المالك. فولدر النسخ الاحتياطية بيفضل دايمًا."
LangString DeleteDataText ${LANG_ENGLISH} "Uninstalling removes the program only. The database and the settings stay in C:\ProgramData\ARTEPOOL, and a new installation finds them as they are.$\r$\n$\r$\nTo delete the data for good, tick this box: you will be asked to type DELETE and the owner's password. The backups folder always stays."
LangString DeleteDataBox ${LANG_ARABIC} "امسح البيانات كمان (فولدر النسخ الاحتياطية بيفضل)"
LangString DeleteDataBox ${LANG_ENGLISH} "Also delete the data (the backups folder stays)"
LangString EmergencyTool ${LANG_ARABIC} "آرتيبول - أداة الطوارئ"
LangString EmergencyTool ${LANG_ENGLISH} "ARTEPOOL - Emergency tool"

Var DataDir
Var LogFile
Var Mode
Var OldVersion
Var DeleteData
Var DeleteBox
Var FailStep
Var FailDetail

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
  StrCpy $DataDir "$APPDATA\ARTEPOOL"
  ${IfNot} ${Silent}
    !insertmacro MUI_LANGDLL_DISPLAY
  ${EndIf}
  !ifdef TEST_BUILD
    ; A test version is never for the shop: one more chance to stop (silent CI runs go on).
    MessageBox MB_ICONEXCLAMATION|MB_OKCANCEL "$(TestBuild)" /SD IDOK IDOK +3
    SetErrorLevel 1
    Abort
  !endif
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
  SetRegView 64
  StrCpy $Mode "install"
  ${If} ${FileExists} "$DataDir\pgdata\PG_VERSION"
    ReadRegStr $OldVersion HKLM "${UNINSTALL_KEY}" "DisplayVersion"
    ${If} $OldVersion == ""
    ${OrIfNot} ${FileExists} "$INSTDIR\artepool-svc.exe"
      ; The data of an earlier installation, the program uninstalled: install again with it,
      ; unless that data comes from a newer version (its migrations would be unknown here).
      ${If} ${FileExists} "$DataDir\config\version.txt"
        FileOpen $1 "$DataDir\config\version.txt" r
        FileRead $1 $OldVersion
        FileClose $1
        ${VersionCompare} "${VERSION}" "$OldVersion" $0
        ${If} $0 == 2
          MessageBox MB_ICONSTOP|MB_OK "$(NotNewer)" /SD IDOK
          SetErrorLevel 4
          Abort
        ${EndIf}
      ${EndIf}
      StrCpy $Mode "reattach"
      Return
    ${EndIf}
    ; 1: this setup is newer.
    ${VersionCompare} "${VERSION}" "$OldVersion" $0
    ${If} $0 != 1
      MessageBox MB_ICONSTOP|MB_OK "$(NotNewer)" /SD IDOK
      SetErrorLevel 4
      Abort
    ${EndIf}
    StrCpy $Mode "upgrade"
  ${EndIf}
FunctionEnd

!macro WriteUninstallKey
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "ARTEPOOL"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1
!macroend

!macro StartServices
  nsExec::ExecToLog '"$SYSDIR\sc.exe" start ArtepoolDatabase'
  Pop $1
  nsExec::ExecToLog '"$SYSDIR\sc.exe" start ArtepoolServer'
  Pop $1
  nsExec::ExecToLog '"$SYSDIR\sc.exe" start ArtepoolBackup'
  Pop $1
!macroend

; The reason the upgrade program left in updates\last-failure.txt (line 1: the step, line 2: why),
; copied into this log so the reason is where people look first.
Function ReadFailure
  StrCpy $FailStep ""
  StrCpy $FailDetail ""
  ClearErrors
  FileOpen $9 "$DataDir\updates\last-failure.txt" r
  ${IfNot} ${Errors}
    FileRead $9 $FailStep
    FileRead $9 $FailDetail
    FileClose $9
    ${TrimNewLines} "$FailStep" $FailStep
    ${TrimNewLines} "$FailDetail" $FailDetail
  ${EndIf}
  ${If} $FailDetail != ""
    !insertmacro Log "Reason ($FailStep): $FailDetail"
  ${EndIf}
FunctionEnd

; Stops with "nothing was changed" (exit code 5): the installed version keeps running.
!macro UpgradeNotDone why
  !insertmacro Log "NOT DONE (${why}); nothing was changed."
  RMDir /r "$INSTDIR.new"
  FileClose $LogFile
  ${If} $FailStep == "test_version"
    MessageBox MB_ICONSTOP|MB_OK "$(UpgradeTestVersion)" /SD IDOK
  ${ElseIf} $FailDetail != ""
    MessageBox MB_ICONSTOP|MB_OK "$(UpgradeNotDone)$\r$\n$\r$\n$(ReasonLabel) $FailDetail" /SD IDOK
  ${Else}
    MessageBox MB_ICONSTOP|MB_OK "$(UpgradeNotDone)" /SD IDOK
  ${EndIf}
  SetErrorLevel 5
  Abort
!macroend

Function Upgrade
  !insertmacro Log "Upgrade $OldVersion -> ${VERSION}"
  !insertmacro Log "Unpacking the new programs to $INSTDIR.new"
  RMDir /r "$INSTDIR.new"
  SetOutPath "$INSTDIR.new"
  File /r "${STAGE}\*"
  WriteUninstaller "$INSTDIR.new\uninstall.exe"
  ; Out of the folder, so it can be renamed.
  SetOutPath "$TEMP"

  ; The desktop app is closed (its own installer runs at the end); the services stop in prepare.
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM artepool-erp.exe'
  Pop $0
  !insertmacro Log "Checks, services stopped, pre-upgrade backup"
  nsExec::ExecToLog '"$INSTDIR.new\artepool-svc.exe" --data "$DataDir" run upgrade prepare --from $OldVersion --to ${VERSION}'
  Pop $0
  ${If} $0 != 0
    Call ReadFailure
    !insertmacro UpgradeNotDone "prepare: exit code $0"
  ${EndIf}

  !insertmacro Log "Swapping the program folders"
  RMDir /r "$INSTDIR.previous"
  ClearErrors
  Rename "$INSTDIR" "$INSTDIR.previous"
  ${If} ${Errors}
    !insertmacro StartServices
    !insertmacro UpgradeNotDone "the program folder is in use"
  ${EndIf}
  ClearErrors
  Rename "$INSTDIR.new" "$INSTDIR"
  ${If} ${Errors}
    Rename "$INSTDIR.previous" "$INSTDIR"
    !insertmacro StartServices
    !insertmacro UpgradeNotDone "the new programs could not take their place"
  ${EndIf}

  !insertmacro Log "Database changes, services, health"
  nsExec::ExecToLog '"$INSTDIR\artepool-svc.exe" --data "$DataDir" run upgrade apply'
  Pop $0
  ${If} $0 != 0
    !insertmacro Log "FAILED (apply: exit code $0): putting the previous version back"
    Call ReadFailure
    RMDir /r "$INSTDIR.failed"
    Rename "$INSTDIR" "$INSTDIR.failed"
    Rename "$INSTDIR.previous" "$INSTDIR"
    !insertmacro StartServices
    !insertmacro Log "The previous version $OldVersion is back; the failed one is in $INSTDIR.failed."
    FileClose $LogFile
    ${If} $FailDetail != ""
      MessageBox MB_ICONSTOP|MB_OK "$(UpgradeRolledBack)$\r$\n$\r$\n$(ReasonLabel) $FailDetail" /SD IDOK
    ${Else}
      MessageBox MB_ICONSTOP|MB_OK "$(UpgradeRolledBack)" /SD IDOK
    ${EndIf}
    SetErrorLevel 6
    Abort
  ${EndIf}
  !insertmacro WriteUninstallKey
FunctionEnd

Section "ARTEPOOL ERP Server" SecServer
  SectionIn RO
  SetShellVarContext all
  ${If} $Mode == "upgrade"
    !insertmacro OpenLog "upgrade"
  ${Else}
    !insertmacro OpenLog "setup"
  ${EndIf}
  ${WinVerGetBuild} $0
  !insertmacro Log "Windows build $0"

  ${If} $Mode == "upgrade"
    Call Upgrade
  ${ElseIf} $Mode == "reattach"
    !insertmacro Log "Installing again with the data kept in $DataDir"
    SetOutPath "$INSTDIR"
    File /r "${STAGE}\*"
    WriteUninstaller "$INSTDIR\uninstall.exe"
    !insertmacro WriteUninstallKey
    !insertmacro Step "The protected secrets of the kept data open on this PC" '"$INSTDIR\artepool-svc.exe" --data "$DataDir" secrets check'
    ${IfNot} ${FileExists} "$DataDir\config\server.json"
      !insertmacro Step "The settings file" '"$INSTDIR\artepool-svc.exe" --data "$DataDir" config init --port ${SERVER_PORT} --database-port auto'
    ${EndIf}
    !insertmacro Step "The database, the services and the certificates" '"$INSTDIR\artepool-svc.exe" --data "$DataDir" run install --reattach'
  ${Else}
    !insertmacro Log "Copying the programs to $INSTDIR"
    SetOutPath "$INSTDIR"
    File /r "${STAGE}\*"
    WriteUninstaller "$INSTDIR\uninstall.exe"
    !insertmacro WriteUninstallKey

    CreateDirectory "$DataDir"
    ; An earlier attempt that stopped before the database was made leaves its secrets and settings
    ; (no data uses them yet): the secrets are used again, the settings made afresh.
    ${If} ${FileExists} "$DataDir\secrets\master-key.dpapi"
      !insertmacro Step "The protected secrets of the earlier attempt open on this PC" '"$INSTDIR\artepool-svc.exe" --data "$DataDir" secrets check'
    ${Else}
      !insertmacro Step "The protected secrets" '"$INSTDIR\artepool-svc.exe" --data "$DataDir" secrets init'
    ${EndIf}
    Delete "$DataDir\config\server.json"
    ; The database's port: 5432, or the next free one if another PostgreSQL already uses it.
    !insertmacro Step "The settings file" '"$INSTDIR\artepool-svc.exe" --data "$DataDir" config init --port ${SERVER_PORT} --database-port auto'
    !insertmacro Step "The database, the services and the certificates" '"$INSTDIR\artepool-svc.exe" --data "$DataDir" run install'
  ${EndIf}

  !insertmacro Log "The ARTEPOOL app"
  ExecWait '"$INSTDIR\app\artepool-erp-setup.exe" /S' $0
  ${If} $0 != 0
    !insertmacro Log "FAILED (the ARTEPOOL app): exit code $0"
    FileClose $LogFile
    MessageBox MB_ICONSTOP|MB_OK "$(StepFailed)" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}

  ; "ARTEPOOL - Emergency tool" (decision 0107): its own manifest asks for administrator rights.
  CreateShortcut "$SMPROGRAMS\$(EmergencyTool).lnk" "$INSTDIR\artepool-emergency.exe"

  ; The version the data now belongs to (a later reinstall never puts an older program over it).
  FileOpen $1 "$DataDir\config\version.txt" w
  FileWrite $1 "${VERSION}"
  FileClose $1
  ${If} $Mode == "upgrade"
    !insertmacro Log "Upgraded to ${VERSION}."
  ${ElseIf} $Mode == "reattach"
    !insertmacro Log "Installed again with the kept data."
  ${Else}
    !insertmacro Log "Installed."
  ${EndIf}
  FileClose $LogFile
SectionEnd

; After an upgrade there is no first-run setup to finish: no "Open ARTEPOOL" box.
Function FinishShow
  ${If} $Mode == "upgrade"
    SendMessage $mui.FinishPage.Run ${BM_SETCHECK} ${BST_UNCHECKED} 0
    ShowWindow $mui.FinishPage.Run ${SW_HIDE}
  ${EndIf}
FunctionEnd

Function OpenApp
  ; The installer runs as administrator, so the app can read the first-run setup files.
  Exec '"${APP_EXE}"'
FunctionEnd

Function un.onInit
  SetShellVarContext all
  StrCpy $DataDir "$APPDATA\ARTEPOOL"
  SetRegView 64
FunctionEnd

!macro UnStep title command
  !insertmacro Log "${title}"
  nsExec::ExecToLog '${command}'
  Pop $0
  !insertmacro Log "  exit code $0"
!macroend

; "Also delete the data" (decision 0103, part G4): unticked; never in a silent uninstall.
Function un.DeleteDataPage
  !insertmacro MUI_HEADER_TEXT "$(DeleteDataTitle)" "$(DeleteDataSub)"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 70u "$(DeleteDataText)"
  Pop $0
  ${NSD_CreateCheckbox} 0 80u 100% 14u "$(DeleteDataBox)"
  Pop $DeleteBox
  nsDialogs::Show
FunctionEnd

Function un.DeleteDataLeave
  ${NSD_GetState} $DeleteBox $DeleteData
FunctionEnd

Section "Uninstall"
  SetShellVarContext all
  !insertmacro OpenLog "uninstall"
  ${If} $DeleteData == ${BST_CHECKED}
    ; Its own window asks for DELETE and the owner's password (checked against the database),
    ; then stops the services and deletes; the backups folder and the logs stay.
    !insertmacro Log "The owner chose to delete the data: the confirmation window opens."
    ExecWait '"$INSTDIR\artepool-svc.exe" --data "$DataDir" run delete-data' $0
    ${If} $0 == 0
      !insertmacro Log "The data was deleted; the backups folder and the logs are kept."
    ${Else}
      !insertmacro Log "The data was not deleted (exit code $0): it is kept."
    ${EndIf}
  ${Else}
    !insertmacro Log "The data in $DataDir is kept (database, backups, secrets, settings)."
  ${EndIf}

  !insertmacro UnStep "Stop ArtepoolBackup" '"$SYSDIR\sc.exe" stop ArtepoolBackup'
  !insertmacro UnStep "Stop ArtepoolServer" '"$SYSDIR\sc.exe" stop ArtepoolServer'
  Sleep 3000
  !insertmacro UnStep "Remove ArtepoolBackup" '"$INSTDIR\winsw\ArtepoolBackup.exe" uninstall'
  !insertmacro UnStep "Remove ArtepoolServer" '"$INSTDIR\winsw\ArtepoolServer.exe" uninstall'
  !insertmacro UnStep "Stop ArtepoolDatabase" '"$SYSDIR\sc.exe" stop ArtepoolDatabase'
  Sleep 5000
  !insertmacro UnStep "Remove ArtepoolDatabase" '"$INSTDIR\pgsql\bin\pg_ctl.exe" unregister -N ArtepoolDatabase'
  !insertmacro UnStep "Remove the firewall rule" '"$SYSDIR\netsh.exe" advfirewall firewall delete rule "name=ARTEPOOL Server"'
  !insertmacro UnStep "Remove the updater task" '"$SYSDIR\schtasks.exe" /Delete /TN "ARTEPOOL Updater" /F'

  ; Both names: the setup may have run in the other language.
  Delete "$SMPROGRAMS\آرتيبول - أداة الطوارئ.lnk"
  Delete "$SMPROGRAMS\ARTEPOOL - Emergency tool.lnk"
  RMDir /r "$INSTDIR"
  ; What upgrades leave beside it (decision 0103).
  RMDir /r "$INSTDIR.previous"
  RMDir /r "$INSTDIR.failed"
  RMDir /r "$INSTDIR.new"
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  !insertmacro Log "Uninstalled. The ARTEPOOL app has its own entry in Apps."
  FileClose $LogFile
SectionEnd
