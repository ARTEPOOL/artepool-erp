; The desktop app's installer (Tauri NSIS) hooks, M6.2 part F5 (decisions 0082, 0083).
;
; - Start at sign-in: the app registers its own scheduled task ("ARTEPOOL ERP", at any person's
;   sign-in, least privilege); on a PC that is not a point of sale the app closes again at once.
; - Before an upgrade or an uninstall, the app and its watchdog are stopped together, so the
;   watchdog does not start the app again while its files are replaced or removed.
; Only Windows' own tools (taskkill, schtasks through the app): every edition (decision 0106).

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM artepool-erp.exe'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  nsExec::Exec '"$INSTDIR\artepool-erp.exe" --register-autostart'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM artepool-erp.exe'
  Pop $0
  nsExec::Exec '"$INSTDIR\artepool-erp.exe" --unregister-autostart'
  Pop $0
!macroend
