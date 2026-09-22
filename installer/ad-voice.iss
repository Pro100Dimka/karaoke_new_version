#ifndef AppSource
  #error AppSource is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif
#ifndef AppVersion
  #define AppVersion "1.0.0"
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
Compression=lzma2/ultra64
SolidCompression=yes
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
Name: "{group}\A&D Voice"; Filename: "{app}\AD Voice.exe"; WorkingDir: "{app}"; IconFilename: "{app}\resources\theme-icons\app.ico"
Name: "{autodesktop}\A&D Voice"; Filename: "{app}\AD Voice.exe"; WorkingDir: "{app}"; IconFilename: "{app}\resources\theme-icons\app.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\AD Voice.exe"; Description: "Запустить A&D Voice"; Flags: nowait postinstall skipifsilent

[Code]
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
