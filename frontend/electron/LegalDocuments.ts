import { app, BrowserWindow, ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { projectRoot, themeIconPath } from './AppPaths';
import { readSavedTheme } from './Splash';
import { ipcChannels, type LegalDocumentState } from './ipcChannels';

const languages = ['ru', 'uk', 'en'] as const;
const receiptFile = () =>
  path.join(app.getPath('userData'), 'legal-acknowledgement.json');
const documents = () =>
  languages.flatMap((language) =>
    (['terms-of-use', 'privacy-policy', 'third-party-licenses'] as const).map(
      (name) => ({
        language,
        name,
        text:
          fs
            .readFileSync(
              path.join(
                projectRoot(),
                'docs',
                'legal',
                `${name}.${language}.md`,
              ),
              'utf8',
            )
            .replaceAll('{{FFMPEG_SOURCE_URL}}', ffmpegSourceUrl()) +
          (name === 'third-party-licenses' ? ffmpegLicenses() : ''),
      }),
    ),
  );
const ffmpegDirectory = () =>
  path.join(projectRoot(), 'docs/third-party/ffmpeg');
const ffmpegSourceUrl = () => {
  const distribution = JSON.parse(
    fs.readFileSync(path.join(ffmpegDirectory(), 'distribution.json'), 'utf8'),
  );
  return `https://github.com/Pro100Dimka/karaoke_new_version/releases/download/v${app.getVersion()}/${distribution.sourceArchive.name}`;
};
const ffmpegLicenses = () =>
  ['GPL-3.0.txt', 'THIRD-PARTY-NOTICES.txt']
    .map((name) => {
      const file = path.join(ffmpegDirectory(), name);
      if (!app.isPackaged && !fs.existsSync(file)) return '';
      return `\n\n${name}\n\n${fs.readFileSync(file, 'utf8')}`;
    })
    .join('');
const revision = () =>
  createHash('sha256').update(JSON.stringify(documents())).digest('hex');
export const legalAcknowledged = (): boolean => {
  try {
    return (
      JSON.parse(fs.readFileSync(receiptFile(), 'utf8')).revision === revision()
    );
  } catch {
    return false;
  }
};
let startupWindow: BrowserWindow | null = null;
const denyNavigation = (event: { preventDefault(): void }) =>
  event.preventDefault();
export const takeLegalStartupWindow = (): BrowserWindow | undefined => {
  const window = startupWindow;
  startupWindow = null;
  if (!window || window.isDestroyed()) return;
  for (const event of [
    'will-navigate',
    'will-frame-navigate',
    'will-redirect',
  ] as const)
    (window.webContents as EventEmitter).removeListener(event, denyNavigation);
  sessions.delete(window.webContents.id);
  return window;
};

const sessions = new Map<
  number,
  {
    url: string;
    window: BrowserWindow;
    state: LegalDocumentState;
    accept(language: string): void;
  }
>();
export const registerLegalViewer = (
  window: BrowserWindow,
  rendererUrl: string,
): void => {
  const allDocuments = documents();
  sessions.set(window.webContents.id, {
    window,
    url: rendererUrl,
    state: {
      language: 'en',
      requireAcknowledgement: false,
      documents: allDocuments,
      draft: allDocuments.some(({ text }) =>
        /ЧЕРНОВИК|ЧЕРНЕТКА|DRAFT/.test(text),
      ),
    },
    accept() {
      throw new Error('Read-only legal documents');
    },
  });
  const id = window.webContents.id;
  window.once('closed', () => sessions.delete(id));
};
ipcMain.handle(
  ipcChannels.legalDocumentRequest,
  (event, action: unknown, language: unknown) => {
    const session = sessions.get(event.sender.id);
    if (
      !session ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame?.url.split('#')[0] !== session.url.split('#')[0]
    )
      throw new Error('Untrusted legal document sender');
    if (action === 'read') return session.state;
    if (action === 'close') {
      if (!session.state.requireAcknowledgement)
        throw new Error('Read-only legal documents');
      session.window.close();
      return;
    }
    if (
      action !== 'accept' ||
      !session.state.requireAcknowledgement ||
      typeof language !== 'string' ||
      !languages.some((value) => value === language)
    )
      throw new Error('Invalid legal document action');
    session.accept(language);
  },
);

/** Loads only the offline legal React screen; service IPC is unavailable to this window. */
export const showLegalDocuments = async (
  rendererUrl: string,
  requestedLanguage: string,
  requireAcknowledgement = false,
): Promise<boolean> => {
  const language =
    languages.find((value) => value === requestedLanguage) ?? 'en';
  const allDocuments = documents();
  const currentRevision = revision();
  const state: LegalDocumentState = {
    language,
    requireAcknowledgement,
    documents: allDocuments,
    draft: allDocuments.some(({ text }) =>
      /ЧЕРНОВИК|ЧЕРНЕТКА|DRAFT/.test(text),
    ),
  };
  const url = new URL(rendererUrl);
  url.hash = 'legal';
  const window = new BrowserWindow({
    width: 1100,
    height: 850,
    minWidth: 620,
    minHeight: 540,
    frame: false,
    show: false,
    title: 'A&D Voice',
    icon: themeIconPath(readSavedTheme()) ?? undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  if (requireAcknowledgement) startupWindow = window;
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', denyNavigation);
  window.webContents.on('will-frame-navigate', denyNavigation);
  window.webContents.on('will-redirect', denyNavigation);
  window.once('ready-to-show', () => window.show());
  const id = window.webContents.id;
  return new Promise<boolean>((resolve, reject) => {
    let accepted = false;
    sessions.set(id, {
      window,
      url: url.href,
      state,
      accept(selectedLanguage) {
        if (accepted) return;
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        fs.writeFileSync(
          receiptFile(),
          JSON.stringify({
            revision: currentRevision,
            language: selectedLanguage,
            draft: state.draft,
            acknowledgedAt: new Date().toISOString(),
          }),
          'utf8',
        );
        accepted = true;
        window.hide();
        resolve(true);
      },
    });
    window.on('closed', () => {
      sessions.delete(id);
      resolve(accepted);
    });
    void window.loadURL(url.href).catch((error) => {
      reject(error);
      window.close();
    });
  });
};
