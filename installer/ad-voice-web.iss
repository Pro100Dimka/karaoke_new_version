; The small AD-Voice-Setup.exe of a release: it downloads the full installer of the same release
; (AD-Voice-Setup-Full.exe, checked against its SHA-256) and runs it with the same options.
;
; Why it exists: versions 1.1.2-1.1.5 of the app download "AD-Voice-Setup.exe" before they open,
; and a second download started 30 s after launch wiped the first, so a 1.1 GB installer never
; arrived. A small one arrives in seconds; this then brings the rest. Downloaded by hand from
; GitHub it works the same way, showing the full installer's own pages after the download.
#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef FullUrl
  #error FullUrl is required
#endif
#ifndef FullSha256
  #error FullSha256 is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif

[Setup]
AppId={{2B3C9E55-7C1A-4F51-9C0B-4C6E0E1A7D21}
AppName=A&D Voice
AppVersion={#AppVersion}
AppPublisher=A&D Voice
CreateAppDir=no
Uninstallable=no
CreateUninstallRegKey=no
PrivilegesRequired=lowest
DisableWelcomePage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
DisableProgramGroupPage=yes
WizardStyle=modern
OutputDir={#OutputDir}
OutputBaseFilename=AD-Voice-Setup
#ifdef AppIcon
SetupIconFile={#AppIcon}
#endif
Compression=lzma2
SolidCompression=yes

[Code]
const
  { The installed app's uninstall key (installer/ad-voice.iss AppId). }
  AppUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{F4FB979B-446D-495E-B00C-D010950EEEB7}_is1';
  FullFile = 'AD-Voice-Setup-Full.exe';

function OnDownloadProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
var
  Percent: Integer;
begin
  if ProgressMax > 0 then
  begin
    Percent := Integer((Progress * 100) div ProgressMax);
    WizardForm.ProgressGauge.Max := 100;
    WizardForm.ProgressGauge.Position := Percent;
    WizardForm.StatusLabel.Caption := Format('Скачиваю A&D Voice {#AppVersion} — %d%%', [Percent]);
  end;
  Result := True;
end;

{ The options this setup was started with (the app's silent update passes its own), for the full one. }
function ForwardedOptions: String;
var
  I: Integer;
  Option: String;
begin
  Result := '';
  for I := 1 to ParamCount do
  begin
    Option := ParamStr(I);
    if (Copy(Option, 1, 1) = '/') and (CompareText(Copy(Option, 1, 4), '/LOG') <> 0) then
      Result := Result + ' ' + AddQuotes(Option);
  end;
end;

function HasOption(const Name: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), Name) = 0 then
      Result := True;
end;

{ A failed update must not leave the person without the app the update closed: it is opened again. }
procedure OpenInstalledApp;
var
  Location: String;
  Code: Integer;
begin
  if not WizardSilent or HasOption('/NORELAUNCH') then
    Exit;
  if not RegQueryStringValue(HKCU, AppUninstallKey, 'InstallLocation', Location) then
    if not RegQueryStringValue(HKLM, AppUninstallKey, 'InstallLocation', Location) then
      Exit;
  Exec(AddBackslash(Location) + 'AD Voice.exe', '', '', SW_SHOW, ewNoWait, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if CurStep <> ssInstall then
    Exit;
  WizardForm.StatusLabel.Caption := 'Скачиваю A&D Voice {#AppVersion}…';
  try
    DownloadTemporaryFile('{#FullUrl}', FullFile, '{#FullSha256}', @OnDownloadProgress);
  except
    Log('Full installer download failed: ' + GetExceptionMessage);
    OpenInstalledApp;
    if not WizardSilent then
      MsgBox('Не удалось скачать A&D Voice. Проверьте подключение к интернету и попробуйте ещё раз.', mbError, MB_OK);
    Abort;
  end;
  // Interactive: the full installer's own pages take over from here.
  if not WizardSilent then
    WizardForm.Hide;
  if not Exec(ExpandConstant('{tmp}\' + FullFile), ForwardedOptions, '', SW_SHOW, ewWaitUntilTerminated, Code) or (Code <> 0) then
  begin
    Log(Format('Full installer did not finish (exit code %d)', [Code]));
    OpenInstalledApp;
  end;
end;
