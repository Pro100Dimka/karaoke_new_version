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
en.GpuPreparing=Preparing NVIDIA GPU acceleration…
ru.GpuPreparing=Подготовка ускорения для видеокарты NVIDIA…
uk.GpuPreparing=Підготовка прискорення для відеокарти NVIDIA…
en.LaunchApp=Launch A&D Voice
ru.LaunchApp=Запустить A&D Voice
uk.LaunchApp=Запустити A&D Voice
en.Models=Download models for song processing (about 3 GB)
ru.Models=Скачать модели для обработки песен (около 3 ГБ)
uk.Models=Завантажити моделі для обробки пісень (близько 3 ГБ)
en.DownloadTitle=Downloading AI components
ru.DownloadTitle=Загрузка компонентов AI
uk.DownloadTitle=Завантаження компонентів AI
en.DownloadHint=Up to 3 downloads at once. NVIDIA acceleration adds about 2.5 GB.
ru.DownloadHint=До 3 загрузок одновременно. NVIDIA: дополнительно около 2,5 ГБ.
uk.DownloadHint=До 3 завантажень одночасно. NVIDIA: додатково близько 2,5 ГБ.
en.DownloadFailed=Some AI components could not be prepared. Retry, or cancel to finish installation without them. They can be downloaded later in the app.
ru.DownloadFailed=Не удалось подготовить часть компонентов AI. Повторите попытку или нажмите «Отмена», чтобы завершить установку без них. Их можно загрузить позже в программе.
uk.DownloadFailed=Не вдалося підготувати частину компонентів AI. Повторіть спробу або натисніть «Скасувати», щоб завершити встановлення без них. Їх можна завантажити пізніше в програмі.
en.DownloadProgress=%1 / %2 MiB; files ready: %3 / %4
ru.DownloadProgress=%1 / %2 МиБ; готово файлов: %3 / %4
uk.DownloadProgress=%1 / %2 МіБ; готово файлів: %3 / %4
en.DownloadVerifying=Downloading and checking files…
ru.DownloadVerifying=Загрузка и проверка файлов…
uk.DownloadVerifying=Завантаження та перевірка файлів…
en.DownloadSkip=Download later
ru.DownloadSkip=Загрузить позже
uk.DownloadSkip=Завантажити пізніше
en.DownloadStopping=Stopping downloads…
ru.DownloadStopping=Остановка загрузок…
uk.DownloadStopping=Зупинка завантажень…
en.CloseBeforeUninstall=Close A&D Voice and wait for processing and recordings to finish before uninstalling.
ru.CloseBeforeUninstall=Закройте A&D Voice и дождитесь завершения обработки и записей перед удалением.
uk.CloseBeforeUninstall=Закрийте A&D Voice і дочекайтеся завершення обробки та записів перед видаленням.
en.DataNotRemoved=These folders were kept because files are in use or exclusive ownership could not be verified. Review their contents before deleting application data; they may contain your other files:
ru.DataNotRemoved=Эти папки сохранены: файлы заняты либо не удалось подтвердить, что всё содержимое принадлежит приложению. Перед удалением данных приложения проверьте содержимое — здесь могут быть другие ваши файлы:
uk.DataNotRemoved=Ці папки збережено: файли зайняті або не вдалося підтвердити, що весь вміст належить застосунку. Перед видаленням даних застосунку перевірте вміст — тут можуть бути інші ваші файли:
en.StorageMoving=Moving application data
ru.StorageMoving=Перенос данных программы
uk.StorageMoving=Перенесення даних програми
en.StorageMovingHint=Songs, recordings, models and settings are being moved into the installation folder.
ru.StorageMovingHint=Песни, записи, модели и настройки переносятся в папку установки.
uk.StorageMovingHint=Пісні, записи, моделі та налаштування переносяться до папки встановлення.

en.StoragePrepare=Preparing application data…
ru.StoragePrepare=Подготовка данных программы…
uk.StoragePrepare=Підготовка даних програми…
en.StorageCopy=Copying files…
ru.StorageCopy=Копирование файлов…
uk.StorageCopy=Копіювання файлів…
en.StorageCatalog=Updating the library and file paths…
ru.StorageCatalog=Обновление библиотеки и путей…
uk.StorageCatalog=Оновлення бібліотеки та шляхів…
en.StorageVerify=Checking data integrity…
ru.StorageVerify=Проверка целостности данных…
uk.StorageVerify=Перевірка цілісності даних…
en.StoragePublish=Opening the relocated library…
ru.StoragePublish=Подключение перенесённой библиотеки…
uk.StoragePublish=Підключення перенесеної бібліотеки…
en.StorageWaiting=Data verified. Finishing the update; cleanup continues when Setup closes…
ru.StorageWaiting=Данные проверены. Очистка старой папки продолжится после закрытия установщика…
uk.StorageWaiting=Дані перевірено. Очищення старої папки продовжиться після закриття інсталятора…
en.StorageCleanup=Cleaning up the old data folder…
ru.StorageCleanup=Очистка старой папки данных…
uk.StorageCleanup=Очищення старої папки даних…
en.StorageDone=Application data is ready. Migration complete.
ru.StorageDone=Данные готовы. Перенос завершён.
uk.StorageDone=Дані готові. Перенесення завершено.
en.StorageError=Data migration could not finish
ru.StorageError=Не удалось завершить перенос данных
uk.StorageError=Не вдалося завершити перенесення даних
en.StorageElapsed=Elapsed: %1 s. Please wait.
ru.StorageElapsed=Прошло %1 с. Пожалуйста, подождите.
uk.StorageElapsed=Минуло %1 с. Будь ласка, зачекайте.
en.StorageMoveFailed=Data migration could not finish. The original data has been preserved. Close other instances, check free space and run the installer again.
ru.StorageMoveFailed=Не удалось завершить перенос. Исходные данные сохранены. Закройте другие экземпляры, проверьте свободное место и запустите установщик повторно.
uk.StorageMoveFailed=Не вдалося завершити перенесення. Вихідні дані збережено. Закрийте інші екземпляри, перевірте вільне місце та запустіть інсталятор повторно.

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopIcon}"; GroupDescription: "{cm:Shortcuts}"; Flags: unchecked
Name: "models"; Description: "{cm:Models}"; Flags: unchecked

[Files]
Source: "{#AppSource}\*"; DestDir: "{app}"; Excludes: "\data\*"; Flags: ignoreversion recursesubdirs createallsubdirs

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
Filename: "{app}\AD Voice.exe"; Description: "{cm:LaunchApp}"; Flags: nowait postinstall skipifsilent; Check: IsStorageReady
; An update installed silently by the app (electron/AutoUpdate.ts) opens the new version; one run
; with /NORELAUNCH leaves it closed.
Filename: "{app}\AD Voice.exe"; Flags: nowait postinstall; Check: ShouldRelaunch

[UninstallDelete]
; Only this application's profile; never remove a shared install directory recursively.
Type: filesandordirs; Name: "{app}\resources"
Type: filesandordirs; Name: "{app}\locales"
Type: dirifempty; Name: "{app}"

[Code]
const
  { Must match the runtime directory used by electron/GpuRuntime.ts. }
  GpuRuntimeDir = '{app}\data\AD Voice\gpu-runtime\torch-2.11.0-cu130';

var
  DownloadPage: TOutputProgressWizardPage;
  StoragePage: TOutputProgressWizardPage;
  StorageReady: Boolean;
  DownloadAbort: TNewButton;
  DownloadCancelFile, DownloadError: string;
  DownloadsCancelled: Boolean;
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

procedure SkipDownloads(Sender: TObject);
begin
  if SaveStringToFile(DownloadCancelFile, 'cancel', False) then
  begin
    DownloadsCancelled := True;
    DownloadAbort.Enabled := False;
    DownloadPage.SetText(CustomMessage('DownloadStopping'), '');
  end;
end;

procedure InitializeWizard;
begin
  StoragePage := CreateOutputProgressPage(CustomMessage('StorageMoving'), CustomMessage('StorageMovingHint'));
  DownloadPage := CreateOutputProgressPage(CustomMessage('DownloadTitle'), CustomMessage('DownloadHint'));
  DownloadAbort := TNewButton.Create(DownloadPage);
  DownloadAbort.Parent := DownloadPage.Surface;
  DownloadAbort.Caption := CustomMessage('DownloadSkip');
  DownloadAbort.Width := ScaleX(160);
  DownloadAbort.Height := WizardForm.CancelButton.Height;
  DownloadAbort.Left := DownloadPage.SurfaceWidth - DownloadAbort.Width;
  DownloadAbort.Top := DownloadPage.ProgressBar.Top + DownloadPage.ProgressBar.Height + ScaleY(16);
  DownloadAbort.OnClick := @SkipDownloads;
end;

procedure DownloadOutput(const S: String; const Error, FirstLine: Boolean);
var
  Parts: TArrayOfString;
  Total, Position: Integer;
  Caption, TotalText: String;
begin
  Parts := StringSplit(S, ['|'], stAll);
  if Error or (GetArrayLength(Parts) <> 6) or (Parts[0] <> 'PROGRESS') then
  begin
    Log(S);
    DownloadError := S;
    Exit;
  end;
  if DownloadsCancelled then Exit;
  Total := StrToIntDef(Parts[2], 0);
  TotalText := Parts[2];
  if Total = 0 then TotalText := '?';
  Caption := CustomMessage('DownloadTitle');
  if Parts[5] = 'VERIFY' then Caption := CustomMessage('DownloadVerifying');
  if Parts[5] = 'GPU' then Caption := CustomMessage('GpuPreparing');
  DownloadAbort.Enabled := Parts[5] <> 'GPU';
  DownloadPage.SetText(Caption,
    FmtMessage(CustomMessage('DownloadProgress'), [Parts[1], TotalText, Parts[3], Parts[4]]));
  if (Total = 0) or (Parts[5] = 'GPU') then
  begin
    DownloadPage.SetProgress(0, 100);
    DownloadPage.ProgressBar.Style := npbstMarquee
  end
  else
  begin
    DownloadPage.ProgressBar.Style := npbstNormal;
    Position := StrToIntDef(Parts[1], 0) * 100 div Total;
    if Parts[3] = Parts[4] then Position := 100
    else if Position >= 100 then Position := 99;
    DownloadPage.SetProgress(Position, 100);
  end;
end;

#include AppCatalog

[Code]

function SetEnvironmentVariable(Name, Value: string): Boolean;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';
function GetCurrentProcessId: Cardinal;
  external 'GetCurrentProcessId@kernel32.dll stdcall';

procedure StorageOutput(const S: String; const Error, FirstLine: Boolean);
var
  Parts: TArrayOfString;
  Caption: String;
  Total: Integer;
begin
  Log(S);
  Parts := StringSplit(S, ['|'], stAll);
  if (GetArrayLength(Parts) = 6) and (Parts[0] = 'STORAGE') then
  begin
    Caption := CustomMessage('Storage' + Parts[1]);
    Total := StrToIntDef(Parts[3], 0);
    if Total > 0 then Caption := Caption + ' (' + Parts[2] + ' / ' + Parts[3] + ')';
    StoragePage.SetText(Caption, FmtMessage(CustomMessage('StorageElapsed'), [Parts[4]]) + ' ' + Parts[5]);
    if Parts[1] = 'Done' then StoragePage.SetProgress(1, 1)
    else if Total > 0 then StoragePage.SetProgress(StrToIntDef(Parts[2], 0), Total)
    else
    begin
      StoragePage.SetProgress(0, 100);
      StoragePage.ProgressBar.Style := npbstMarquee;
    end;
    if Parts[1] = 'Error' then StoragePage.ProgressBar.State := npbsError;
  end;
  if Copy(S, 1, 14) = 'STORAGE_ERROR|' then DownloadError := Copy(S, 15, Length(S));
end;

function IsStorageReady: Boolean;
begin
  Result := StorageReady;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Params: string;
  Code, I: Integer;
  Names, Folders: TArrayOfString;
begin
  { Older versions start updates with /VERYSILENT. Keep their first migration visible too. }
  if CurStep = ssInstall then WizardForm.Show;
  if CurStep <> ssPostInstall then Exit;
  Names := ['TEMP', 'TMP', 'NUMBA_CACHE_DIR', 'TORCH_HOME', 'HF_HOME', 'PIP_CACHE_DIR'];
  Folders := ['temp', 'temp', 'cache\numba', 'cache\torch', 'cache\huggingface', 'cache\pip'];
  for I := 0 to GetArrayLength(Names) - 1 do
    SetEnvironmentVariable(Names[I], ExpandConstant('{app}\data\' + Folders[I]));
  ForceDirectories(ExpandConstant('{app}\data\temp'));
  DownloadCancelFile := ExpandConstant('{app}\data\temp\downloads.cancel');
  Params := '-E -B -u -m backend.infrastructure.profile_migration ' +
    AddQuotes(ExpandConstant('{userappdata}\AD Voice')) + ' ' +
    AddQuotes(ExpandConstant('{app}\data\AD Voice')) +
    ' --wait-parent ' + IntToStr(GetCurrentProcessId);
  StoragePage.Show;
  try
    StoragePage.SetText(CustomMessage('StoragePrepare'), '');
    StoragePage.SetProgress(0, 100);
    StoragePage.ProgressBar.Style := npbstMarquee;
    DownloadError := '';
    Code := -1;
    try
      StorageReady := ExecAndLogOutput(ExpandConstant('{app}\resources\python-runtime\python.exe'),
        Params, ExpandConstant('{app}\resources\python-app'), SW_HIDE,
        ewWaitUntilTerminated, Code, @StorageOutput) and (Code = 0);
    except
      DownloadError := GetExceptionMessage;
      StorageReady := False;
    end;
    if not StorageReady then
    begin
      if DownloadError = '' then DownloadError := SysErrorMessage(Code);
      StoragePage.ProgressBar.State := npbsError;
      MsgBox(CustomMessage('StorageMoveFailed') + #13#10 + DownloadError, mbError, MB_OK or MB_SETFOREGROUND);
      Abort;
    end;
  finally
    StoragePage.Hide;
  end;
  { Installed Python runs the shared queue before the app opens. Silent updates never wait for AI files. }
  if WizardSilent then Exit;
  if not (WizardIsTaskSelected('models') or NeedsGpuRuntime) then Exit;
  Params := '-E -B -u -m backend.infrastructure.installer_downloads ' +
    AddQuotes(ExpandConstant('{app}\data\AD Voice')) +
    ' --cancel-file ' + AddQuotes(DownloadCancelFile);
  if WizardIsTaskSelected('models') then Params := Params + ' --models';
  if NeedsGpuRuntime then Params := Params + ' --gpu ' + AddQuotes(ExpandConstant(GpuRuntimeDir));
  DownloadPage.Show;
  try
    repeat
      DeleteFile(DownloadCancelFile);
      DownloadsCancelled := False;
      DownloadAbort.Enabled := True;
      DownloadError := '';
      DownloadPage.SetText(CustomMessage('DownloadVerifying'), '');
      DownloadPage.SetProgress(0, 100);
      DownloadPage.ProgressBar.Style := npbstMarquee;
      Code := -1;
      try
        if not ExecAndLogOutput(ExpandConstant('{app}\resources\python-runtime\python.exe'),
          Params, ExpandConstant('{app}\resources\python-app'), SW_SHOWNORMAL,
          ewWaitUntilTerminated, Code, @DownloadOutput) then
          DownloadError := SysErrorMessage(Code);
      except
        DownloadError := GetExceptionMessage;
      end;
      if (Code = 0) or (Code = 2) then Break;
    until MsgBox(CustomMessage('DownloadFailed') + #13#10 + DownloadError,
      mbError, MB_RETRYCANCEL) <> IDRETRY;
  finally
    DownloadPage.Hide;
    DeleteFile(DownloadCancelFile);
  end;
end;

function GetCustomSetupExitCode: Integer;
begin
  Result := 0;
  if not StorageReady then Result := 1;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and not StorageReady then
  begin
    WizardForm.FinishedHeadingLabel.Caption := CustomMessage('StorageError');
    WizardForm.FinishedLabel.Caption := CustomMessage('StorageMoveFailed');
  end;
end;

function ShouldRelaunch: Boolean;
var
  I: Integer;
begin
  Result := WizardSilent and StorageReady;
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
  if CompareText(Root, ExpandConstant('{app}\data\AD Voice\backend-data')) <> 0 then
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
  Code: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    Profile := ExpandConstant('{app}\data\AD Voice');
    if not Exec(ExpandConstant('{app}\resources\python-runtime\python.exe'),
      '-E -B -m backend.infrastructure.profile_migration ' +
      AddQuotes(ExpandConstant('{userappdata}\AD Voice')) + ' ' + AddQuotes(Profile) +
      ' --unlink-compatibility', ExpandConstant('{app}\resources\python-app'),
      SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
    begin
      RemainingData := Profile;
      Exit;
    end;
    if LoadStringsFromFile(Profile + '\storage-roots.txt', Roots) then
      for I := 0 to GetArrayLength(Roots) - 1 do DeleteStorageRoot(Roots[I]);
    if LoadStringsFromFile(Profile + '\storage-root.txt', Roots) then
      for I := 0 to GetArrayLength(Roots) - 1 do DeleteStorageRoot(Roots[I]);
    DeleteStorageRoot(Profile + '\backend-data');
    if RemainingData = '' then
      if DirExists(Profile) then
        if not DelTree(Profile, True, True, True) then RemainingData := Profile;
    if RemainingData = '' then
    begin
      Roots := ['cache', 'temp'];
      for I := 0 to GetArrayLength(Roots) - 1 do
        if DirExists(ExpandConstant('{app}\data\' + Roots[I])) then
          if not DelTree(ExpandConstant('{app}\data\' + Roots[I]), True, True, True) then
            RemainingData := ExpandConstant('{app}\data');
      DeleteFile(ExpandConstant('{app}\data\storage-layout.json'));
      DeleteFile(ExpandConstant('{app}\data\storage-migration.log'));
      DeleteFile(ExpandConstant('{app}\data\storage-progress.json'));
      DeleteFile(ExpandConstant('{app}\data\.storage-worker.lock.guard'));
      RemoveDir(ExpandConstant('{app}\data'));
    end;
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
