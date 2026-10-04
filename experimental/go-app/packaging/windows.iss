; Unsigned preview. Current-user scope, no elevation/autostart/runtime download.
#ifndef PreviewDir
  #error PreviewDir is required
#endif
#ifndef DownloadDir
  #error DownloadDir is required
#endif
#ifndef AppVersion
  #error AppVersion is required
#endif
[Setup]
AppId=us.momoapi.go.preview
AppName=MOMO API Preview
AppVersion={#AppVersion}
AppPublisher=MOMO API
DefaultDirName={localappdata}\Programs\MOMO API Preview
DefaultGroupName=MOMO API Preview
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#DownloadDir}
OutputBaseFilename=momo-preview-Windows-X64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\momo-preview.exe
CloseApplications=yes
RestartApplications=no
SetupLogging=no

[Files]
Source: "{#PreviewDir}\momo-preview.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PreviewDir}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PreviewDir}\SHA256SUMS"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\MOMO API Preview"; Filename: "{app}\momo-preview.exe"
Name: "{group}\Uninstall MOMO API Preview"; Filename: "{uninstallexe}"

; No Run, Registry autostart or broad UninstallDelete entries. OS credentials
; and WebView user data intentionally preserved, never enumerated by uninstall.
