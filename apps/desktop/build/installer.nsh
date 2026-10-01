; Milibot hooks for electron-builder's NSIS installer (`nsis.include` in scripts/package/config.mjs).

; The installer's running-app check force-kills every process under $INSTDIR, the daemon's node.exe
; included. Asking the installed app to stop the daemon first lets it suspend the VMs cleanly.
!macro milibotStopDaemon
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --stop-daemon'
  ${EndIf}
!macroend

!macro customInit
  !insertmacro milibotStopDaemon
!macroend

!macro customUnInit
  !insertmacro milibotStopDaemon
!macroend

; The login item (see login-item/windows.ts) would otherwise point to a missing executable.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Milibot"
  ${EndIf}
!macroend
