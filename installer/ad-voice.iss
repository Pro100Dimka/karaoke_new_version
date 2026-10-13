#ifndef AppSource
  #error AppSource is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef LzmaThreads
  #define LzmaThreads GetEnv("NUMBER_OF_PROCESSORS")
#endif
#ifndef LzmaDictionaryKb
  #error LzmaDictionaryKb is required
#endif

[Setup]
AppId={{F4FB979B-446D-495E-B00C-D010950EEEB7}
AppName=A&D Voice
AppVersion={#AppVersion}
AppPublisher=A&D Voice
DefaultDirName={code:GetDefaultDirName}
DefaultGroupName=A&D Voice
UninstallDisplayIcon={app}\AD Voice.exe
OutputDir={#OutputDir}
OutputBaseFilename=AD-Voice-Setup
; Multithreaded LZMA2: single-threaded ultra64 took most of the release time on the AI runtime.
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
LZMANumBlockThreads={#LzmaThreads}
LZMADictionarySize={#LzmaDictionaryKb}
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no
SetupIconFile={#AppIcon}

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; GroupDescription: "Ярлыки:"; Flags: unchecked

[Files]
Source: "{#AppSource}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; AppUserModelID matches app.setAppUserModelId in electron/main.ts: Windows notifications need it.
Name: "{group}\A&D Voice"; Filename: "{app}\AD Voice.exe"; WorkingDir: "{app}"; IconFilename: "{app}\resources\theme-icons\app.ico"; AppUserModelID: "ADVoice.App"
Name: "{autodesktop}\A&D Voice"; Filename: "{app}\AD Voice.exe"; WorkingDir: "{app}"; IconFilename: "{app}\resources\theme-icons\app.ico"; AppUserModelID: "ADVoice.App"; Tasks: desktopicon

[Registry]
; Notifications name their sender "A&D Voice" with the app's icon (electron/NotificationIdentity.ts writes
; the same at start-up); listed here so uninstalling removes it.
Root: HKA; Subkey: "Software\Classes\AppUserModelId\ADVoice.App"; ValueType: string; ValueName: "DisplayName"; ValueData: "A&D Voice"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\AppUserModelId\ADVoice.App"; ValueType: string; ValueName: "IconUri"; ValueData: "{app}\resources\theme-icons\dark.png"
; advoice://room/CODE invitation links open the app (electron/DesktopShell.ts roomCodeFromLink).
Root: HKA; Subkey: "Software\Classes\advoice"; ValueType: string; ValueName: ""; ValueData: "URL:A&D Voice"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\advoice"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\advoice\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\AD Voice.exe"",0"
Root: HKA; Subkey: "Software\Classes\advoice\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\AD Voice.exe"" ""%1"""
; "Open with A&D Voice" for audio files: offered in Explorer, never taking over the default player.
Root: HKA; Subkey: "Software\Classes\ADVoice.Audio"; ValueType: string; ValueName: ""; ValueData: "A&D Voice"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\ADVoice.Audio\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\AD Voice.exe"",0"
Root: HKA; Subkey: "Software\Classes\ADVoice.Audio\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\AD Voice.exe"" ""%1"""
Root: HKA; Subkey: "Software\Classes\Applications\AD Voice.exe"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "A&D Voice"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\Applications\AD Voice.exe\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\AD Voice.exe"" ""%1"""
Root: HKA; Subkey: "Software\Classes\Applications\AD Voice.exe\SupportedTypes"; ValueType: string; ValueName: ".mp3"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\AD Voice.exe\SupportedTypes"; ValueType: string; ValueName: ".wav"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\AD Voice.exe\SupportedTypes"; ValueType: string; ValueName: ".flac"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\AD Voice.exe\SupportedTypes"; ValueType: string; ValueName: ".m4a"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\AD Voice.exe\SupportedTypes"; ValueType: string; ValueName: ".ogg"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\.mp3\OpenWithProgids"; ValueType: string; ValueName: "ADVoice.Audio"; ValueData: ""; Flags: uninsdeletevalue
Root: HKA; Subkey: "Software\Classes\.wav\OpenWithProgids"; ValueType: string; ValueName: "ADVoice.Audio"; ValueData: ""; Flags: uninsdeletevalue
Root: HKA; Subkey: "Software\Classes\.flac\OpenWithProgids"; ValueType: string; ValueName: "ADVoice.Audio"; ValueData: ""; Flags: uninsdeletevalue
Root: HKA; Subkey: "Software\Classes\.m4a\OpenWithProgids"; ValueType: string; ValueName: "ADVoice.Audio"; ValueData: ""; Flags: uninsdeletevalue
Root: HKA; Subkey: "Software\Classes\.ogg\OpenWithProgids"; ValueType: string; ValueName: "ADVoice.Audio"; ValueData: ""; Flags: uninsdeletevalue

[Run]
Filename: "{app}\AD Voice.exe"; Description: "Запустить A&D Voice"; Flags: nowait postinstall skipifsilent
; An update the user asked for (electron/AutoUpdate.ts, "Update now") starts the app again; one
; installed while the app was being closed (/NORELAUNCH) leaves it closed.
Filename: "{app}\AD Voice.exe"; Flags: nowait; Check: ShouldRelaunch

[Code]
function ShouldRelaunch: Boolean;
var
  I: Integer;
begin
  Result := WizardSilent;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), '/NORELAUNCH') = 0 then
      Result := False;
end;

const
  DRIVE_FIXED = 3;

function GetDriveType(lpRootPathName: string): Cardinal;
  external 'GetDriveTypeW@kernel32.dll stdcall';

function GetDefaultDirName(Param: string): string;
var
  DriveCode: Integer;
  DriveRoot: string;
begin
  for DriveCode := Ord('D') to Ord('Z') do
  begin
    DriveRoot := Chr(DriveCode) + ':\';
    if GetDriveType(DriveRoot) = DRIVE_FIXED then
    begin
      Result := DriveRoot + 'AD Voice';
      Exit;
    end;
  end;

  Result := ExpandConstant('{localappdata}\Programs\AD Voice');
end;
