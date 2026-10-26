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

[CustomMessages]
en.Models=Download models for song processing (about 3 GB)
ru.Models=Скачать модели для обработки песен (около 3 ГБ)
uk.Models=Завантажити моделі для обробки пісень (близько 3 ГБ)
en.DownloadTitle=Downloading AI models
ru.DownloadTitle=Загрузка AI-моделей
uk.DownloadTitle=Завантаження AI-моделей
en.DownloadHint=Models are verified before use. You can also download them later in Settings.
ru.DownloadHint=Файлы проверяются перед использованием. Модели также можно скачать позже в настройках.
uk.DownloadHint=Файли перевіряються перед використанням. Моделі також можна завантажити пізніше в налаштуваннях.
en.DownloadFailed=The models could not be downloaded. Retry, or go back and deselect model download to continue without them.
ru.DownloadFailed=Не удалось скачать модели. Повторите попытку или вернитесь назад и снимите флажок загрузки моделей.
uk.DownloadFailed=Не вдалося завантажити моделі. Повторіть спробу або поверніться назад і зніміть прапорець завантаження моделей.

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; GroupDescription: "Ярлыки:"; Flags: unchecked
Name: "models"; Description: "{cm:Models}"; Flags: unchecked

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
; The CUDA build of PyTorch on an NVIDIA computer, so the first song is already processed on the GPU:
; unpacked from the wheels the download page fetched. A silent update (installed by the app before
; it opens) skips this so the app opens at once; the app then fetches it in the background itself.
Filename: "{app}\resources\python-runtime\python.exe"; Parameters: "-E -m backend.infrastructure.torch_runtime install-gpu ""{userappdata}\AD Voice\gpu-runtime\torch-2.11.0-cu130"""; WorkingDir: "{app}\resources\python-app"; StatusMsg: "Подготовка ускорения для видеокарты NVIDIA…"; Flags: runhidden waituntilterminated; Check: UnpackGpuRuntime
Filename: "{app}\AD Voice.exe"; Description: "Запустить A&D Voice"; Flags: nowait postinstall skipifsilent
; An update installed silently by the app (electron/AutoUpdate.ts) opens the new version; one run
; with /NORELAUNCH leaves it closed.
Filename: "{app}\AD Voice.exe"; Flags: nowait; Check: ShouldRelaunch

[UninstallDelete]
; Only this application's profile; never remove a shared install directory recursively.
Type: filesandordirs; Name: "{userappdata}\AD Voice"
Type: dirifempty; Name: "{app}"

[Code]
const
  { Must match GPU_WHEELS in python/backend/infrastructure/torch_runtime.py (a test checks it). }
  GpuRuntimeDir = '{userappdata}\AD Voice\gpu-runtime\torch-2.11.0-cu130';
  GpuDownloadsDir = '{userappdata}\AD Voice\gpu-runtime\downloads';
  TorchUrl = 'https://download.pytorch.org/whl/cu130/torch-2.11.0%2Bcu130-cp313-cp313-win_amd64.whl';
  TorchFile = 'torch-2.11.0+cu130-cp313-cp313-win_amd64.whl';
  TorchSha256 = '339801f2163698a53c7fb3c91883e7f44331d22c34d45acfbce4eff71f2332fa';
  TorchaudioUrl = 'https://download.pytorch.org/whl/cu130/torchaudio-2.11.0%2Bcu130-cp313-cp313-win_amd64.whl';
  TorchaudioFile = 'torchaudio-2.11.0+cu130-cp313-cp313-win_amd64.whl';
  TorchaudioSha256 = 'ce09a7b144b7982b46c8fe399cf5f91d43dda571e9d6ddba67e928567551f614';

var
  DownloadPage: TDownloadWizardPage;
  ModelDownloadPage: TDownloadWizardPage;
  GpuChecked: Boolean;
  GpuPresent: Boolean;

{ An NVIDIA GPU with its driver: nvidia-smi lists it. }
function HasNvidiaGpu: Boolean;
var
  Code: Integer;
begin
  if not GpuChecked then
  begin
    GpuChecked := True;
    GpuPresent :=
      (Exec(ExpandConstant('{sys}\nvidia-smi.exe'), '-L', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0)) or
      (Exec(ExpandConstant('{commonpf64}\NVIDIA Corporation\NVSMI\nvidia-smi.exe'), '-L', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0));
  end;
  Result := GpuPresent;
end;

function NeedsGpuRuntime: Boolean;
begin
  Result := (not FileExists(ExpandConstant(GpuRuntimeDir + '\.complete'))) and HasNvidiaGpu;
end;

{ An interactive setup unpacks the CUDA build; a silent update leaves it to the app. }
function UnpackGpuRuntime: Boolean;
begin
  Result := (not WizardSilent) and NeedsGpuRuntime;
end;

{ Keeps a downloaded wheel where torch_runtime.py looks for verified downloads before fetching. }
procedure KeepDownload(const Name: string);
var
  Source, Target: string;
begin
  Source := ExpandConstant('{tmp}\' + Name);
  Target := ExpandConstant(GpuDownloadsDir);
  ForceDirectories(Target);
  if not RenameFile(Source, Target + '\' + Name) then
    FileCopy(Source, Target + '\' + Name, False);
end;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage('Ускорение для видеокарты NVIDIA',
    'Скачиваю его один раз (около 2,5 ГБ), чтобы песни обрабатывались на видеокарте.', nil);
  ModelDownloadPage := CreateDownloadPage(CustomMessage('DownloadTitle'), CustomMessage('DownloadHint'), nil);
end;

function VerifiedModel(const Target, Checksum: string): Boolean;
begin
  Result := False;
  if FileExists(ExpandConstant(Target)) then
    Result := CompareText(GetSHA256OfFile(ExpandConstant(Target)), Checksum) = 0;
end;

procedure KeepModel(const Name, RelativeDir: string);
var
  Source, Target: string;
begin
  Source := ExpandConstant('{tmp}\' + Name);
  if not FileExists(Source) then Exit;
  Target := ExpandConstant('{userappdata}\AD Voice\backend-data\models\' + RelativeDir);
  if not ForceDirectories(Target) then RaiseException('Cannot create model directory: ' + Target);
  Target := Target + '\model.bin';
  if not FileCopy(Source, Target, False) then RaiseException('Cannot save model: ' + Target);
  DeleteFile(Source);
end;

#include AppCatalog

[Code]

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID <> wpReady then Exit;
  if WizardIsTaskSelected('models') then
    try
      DownloadModels;
    except
      MsgBox(CustomMessage('DownloadFailed') + #13#10 + GetExceptionMessage, mbError, MB_OK);
      Result := False;
      Exit;
    end;
  if not NeedsGpuRuntime then Exit;
  DownloadPage.Clear;
  DownloadPage.Add(TorchUrl, TorchFile, TorchSha256);
  DownloadPage.Add(TorchaudioUrl, TorchaudioFile, TorchaudioSha256);
  DownloadPage.Show;
  try
    try
      DownloadPage.Download;
      KeepDownload(TorchFile);
      KeepDownload(TorchaudioFile);
    except
      { No connection, a cancelled or broken download: setup goes on, the app fetches it later. }
      Log('GPU runtime download skipped: ' + GetExceptionMessage);
    end;
  finally
    DownloadPage.Hide;
  end;
end;

function ShouldRelaunch: Boolean;
var
  I: Integer;
begin
  Result := WizardSilent;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), '/NORELAUNCH') = 0 then
      Result := False;
end;

procedure DeleteStorageRoot(const Folder: string);
var
  Root: string;
  Marker: AnsiString;
  Names: TArrayOfString;
  I: Integer;
begin
  Root := RemoveBackslash(ExpandFileName(Trim(Folder)));
  if (Root = '') or (Length(Root) <= 3) then Exit;
  if not LoadStringFromFile(Root + '\.ad-voice-data', Marker) then Exit;
  if Marker <> 'ADVoice.App' then Exit;
  Names := ['songs', 'models', 'cache', 'recordings', 'temp', 'quarantine', 'logs', 'recovery'];
  for I := 0 to GetArrayLength(Names) - 1 do
    if DirExists(Root + '\' + Names[I]) then
      if not DelTree(Root + '\' + Names[I], True, True, True) then
        Log('Could not remove data: ' + Root + '\' + Names[I]);
  DeleteFile(Root + '\app.db');
  DeleteFile(Root + '\app.db-wal');
  DeleteFile(Root + '\app.db-shm');
  DeleteFile(Root + '\.ad-voice-data');
  RemoveDir(Root);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Roots: TArrayOfString;
  I: Integer;
begin
  if CurUninstallStep <> usUninstall then Exit;
  if LoadStringsFromFile(ExpandConstant('{userappdata}\AD Voice\storage-roots.txt'), Roots) then
    for I := 0 to GetArrayLength(Roots) - 1 do
      DeleteStorageRoot(Roots[I]);
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
