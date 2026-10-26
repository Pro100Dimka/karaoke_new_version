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

[Messages]
en.ConfirmUninstall=Remove %1, including all processed songs, recordings, models and application settings? This cannot be undone.
ru.ConfirmUninstall=Удалить %1 вместе со всеми обработанными песнями, записями, моделями и настройками? Это действие нельзя отменить.
uk.ConfirmUninstall=Видалити %1 разом з усіма обробленими піснями, записами, моделями й налаштуваннями? Цю дію неможливо скасувати.

[CustomMessages]
en.DesktopIcon=Create a desktop shortcut
ru.DesktopIcon=Создать ярлык на рабочем столе
uk.DesktopIcon=Створити ярлик на робочому столі
en.Shortcuts=Shortcuts:
ru.Shortcuts=Ярлыки:
uk.Shortcuts=Ярлики:
en.GpuTitle=NVIDIA GPU acceleration
ru.GpuTitle=Ускорение для видеокарты NVIDIA
uk.GpuTitle=Прискорення для відеокарти NVIDIA
en.GpuHint=Downloading once (about 2.5 GB) to process songs on your GPU.
ru.GpuHint=Однократная загрузка (около 2,5 ГБ) для обработки песен на видеокарте.
uk.GpuHint=Одноразове завантаження (близько 2,5 ГБ) для обробки пісень на відеокарті.
en.GpuPreparing=Preparing NVIDIA GPU acceleration…
ru.GpuPreparing=Подготовка ускорения для видеокарты NVIDIA…
uk.GpuPreparing=Підготовка прискорення для відеокарти NVIDIA…
en.LaunchApp=Launch A&D Voice
ru.LaunchApp=Запустить A&D Voice
uk.LaunchApp=Запустити A&D Voice
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
en.CloseBeforeUninstall=Close A&D Voice and wait for processing and recordings to finish before uninstalling.
ru.CloseBeforeUninstall=Закройте A&D Voice и дождитесь завершения обработки и записей перед удалением.
uk.CloseBeforeUninstall=Закрийте A&D Voice і дочекайтеся завершення обробки та записів перед видаленням.
en.DataNotRemoved=These folders were kept because files are in use or exclusive ownership could not be verified. Review their contents before deleting application data; they may contain your other files:
ru.DataNotRemoved=Эти папки сохранены: файлы заняты либо не удалось подтвердить, что всё содержимое принадлежит приложению. Перед удалением данных приложения проверьте содержимое — здесь могут быть другие ваши файлы:
uk.DataNotRemoved=Ці папки збережено: файли зайняті або не вдалося підтвердити, що весь вміст належить застосунку. Перед видаленням даних застосунку перевірте вміст — тут можуть бути інші ваші файли:

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopIcon}"; GroupDescription: "{cm:Shortcuts}"; Flags: unchecked
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
Filename: "{app}\resources\python-runtime\python.exe"; Parameters: "-E -m backend.infrastructure.torch_runtime install-gpu ""{userappdata}\AD Voice\gpu-runtime\torch-2.11.0-cu130"""; WorkingDir: "{app}\resources\python-app"; StatusMsg: "{cm:GpuPreparing}"; Flags: runhidden waituntilterminated; Check: UnpackGpuRuntime
Filename: "{app}\AD Voice.exe"; Description: "{cm:LaunchApp}"; Flags: nowait postinstall skipifsilent
; An update installed silently by the app (electron/AutoUpdate.ts) opens the new version; one run
; with /NORELAUNCH leaves it closed.
Filename: "{app}\AD Voice.exe"; Flags: nowait; Check: ShouldRelaunch

[UninstallDelete]
; Only this application's profile; never remove a shared install directory recursively.
Type: filesandordirs; Name: "{app}\resources"
Type: filesandordirs; Name: "{app}\locales"
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
  RemainingData: string;
  CheckedRoots: string;

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
  DownloadPage := CreateDownloadPage(CustomMessage('GpuTitle'), CustomMessage('GpuHint'), nil);
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

function InitializeUninstall: Boolean;
var
  Locator, Services, Processes, Process: Variant;
  Targets: TArrayOfString;
  I, J: Integer;
begin
  Result := False;
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Services := Locator.ConnectServer('.', 'root\CIMV2');
    Processes := Services.ExecQuery('SELECT ExecutablePath FROM Win32_Process');
    Targets := [ExpandConstant('{app}\AD Voice.exe'),
      ExpandConstant('{app}\resources\python-runtime\python.exe'),
      ExpandConstant('{app}\resources\audio-service\AudioService.exe')];
    for I := 0 to Processes.Count - 1 do
    begin
      Process := Processes.ItemIndex(I);
      if not VarIsNull(Process.ExecutablePath) then
        for J := 0 to GetArrayLength(Targets) - 1 do
          if CompareText(Process.ExecutablePath, Targets[J]) = 0 then
          begin
            MsgBox(CustomMessage('CloseBeforeUninstall'), mbError, MB_OK);
            Exit;
          end;
    end;
    Result := True;
  except
    MsgBox(CustomMessage('CloseBeforeUninstall') + #13#10 + GetExceptionMessage, mbError, MB_OK);
  end;
end;

procedure DeleteStorageRoot(const Folder: string);
var
  Root: string;
  Marker: AnsiString;
  Names: TArrayOfString;
  I: Integer;
  Removed: Boolean;
begin
  Root := RemoveBackslash(ExpandFileName(Trim(Folder)));
  if (Root = '') or (Length(Root) <= 3) then Exit;
  if not DirExists(Root) then Exit;
  if Pos(#10 + Lowercase(Root) + #10, CheckedRoots) > 0 then Exit;
  CheckedRoots := CheckedRoots + #10 + Lowercase(Root) + #10;
  { The fixed application profile is private. Custom roots need proof they started empty;
    the old marker was also written into folders containing unrelated user data. }
  if CompareText(Root, ExpandConstant('{userappdata}\AD Voice\backend-data')) <> 0 then
    if not LoadStringFromFile(Root + '\.ad-voice-data', Marker) or (Marker <> 'ADVoice.App.v2') then
    begin
      RemainingData := RemainingData + #13#10 + Root;
      Exit;
    end;
  { A live backend holds this file open. Do not touch its library. }
  if FileExists(Root + '\backend.lock.guard') then
    if not DeleteFile(Root + '\backend.lock.guard') then
    begin
      RemainingData := RemainingData + #13#10 + Root;
      Exit;
    end;
  Removed := True;
  Names := ['songs', 'models', 'cache', 'recordings', 'temp', 'quarantine', 'logs', 'recovery', 'environment', 'backups', 'exports'];
  for I := 0 to GetArrayLength(Names) - 1 do
    if DirExists(Root + '\' + Names[I]) then
      if not DelTree(Root + '\' + Names[I], True, True, True) then
        Removed := False;
  Names := ['app.db', 'app.db-wal', 'app.db-shm', 'backend.lock'];
  for I := 0 to GetArrayLength(Names) - 1 do
    if FileExists(Root + '\' + Names[I]) then
      if not DeleteFile(Root + '\' + Names[I]) then Removed := False;
  if not Removed then
  begin
    RemainingData := RemainingData + #13#10 + Root;
    Exit;
  end;
  DeleteFile(Root + '\.ad-voice-data');
  RemoveDir(Root);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Roots: TArrayOfString;
  Profile: string;
  I: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    Profile := ExpandConstant('{userappdata}\AD Voice');
    if LoadStringsFromFile(Profile + '\storage-roots.txt', Roots) then
      for I := 0 to GetArrayLength(Roots) - 1 do DeleteStorageRoot(Roots[I]);
    if LoadStringsFromFile(Profile + '\storage-root.txt', Roots) then
      for I := 0 to GetArrayLength(Roots) - 1 do DeleteStorageRoot(Roots[I]);
    DeleteStorageRoot(Profile + '\backend-data');
    if RemainingData = '' then
      if DirExists(Profile) then
        if not DelTree(Profile, True, True, True) then RemainingData := Profile;
  end;
  if (CurUninstallStep = usPostUninstall) and (RemainingData <> '') then
    MsgBox(CustomMessage('DataNotRemoved') + #13#10 + RemainingData, mbError, MB_OK);
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
