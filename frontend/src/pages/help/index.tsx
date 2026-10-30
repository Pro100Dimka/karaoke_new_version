import { useLocale, Button, Card, tr, useRouter } from "@neo-ui-kit/react";
import { useState } from "react";

import { store } from "../../providers/store";
import { ru } from "../../i18n/messages.ru";
import type { MessageKey } from "../../i18n/messages";
import { routes } from "../../shared/routes";

const chapters = [
  { id: "start", icon: "rocket", title: "helpStart", paragraphs: ["helpStart1", "helpStart2"] },
  { id: "audio", icon: "headphones", title: "helpAudio", paragraphs: ["helpAudio1", "helpAudio2", "helpAudio3"], image: "audio" },
  { id: "models", icon: "chip", title: "helpModels", paragraphs: ["helpModels1", "helpModels2", "helpModels3"], image: "models" },
  { id: "processing", icon: "processing", title: "helpProcessing", paragraphs: ["helpProcessing1", "helpProcessing2", "helpProcessing3"] },
  { id: "library", icon: "music", title: "helpLibrary", paragraphs: ["helpLibrary1", "helpLibrary2"], image: "library" },
  { id: "karaoke", icon: "mic", title: "helpKaraoke", paragraphs: ["helpKaraoke1", "helpKaraoke2", "helpKaraoke3"] },
  { id: "keys", icon: "key", title: "helpKeys", paragraphs: ["helpKeys1", "helpKeys2", "helpKeys3"] },
  { id: "editor", icon: "pencil", title: "helpEditor", paragraphs: ["helpEditor1", "helpEditor2"] },
  { id: "recordings", icon: "headphones", title: "helpRecordings", paragraphs: ["helpRecordings1", "helpRecordings2"] },
  { id: "rooms", icon: "users", title: "helpRooms", paragraphs: ["helpRooms1", "helpRooms2", "helpRooms3"] },
  { id: "trouble", icon: "wrench", title: "helpTrouble", paragraphs: ["helpTrouble1", "helpTrouble2", "helpTrouble3"] },
] as const satisfies readonly { id: string; icon: string; title: MessageKey; paragraphs: readonly MessageKey[]; image?: string }[];

export const HelpPage = () => {
  useLocale();
  const { navigate } = useRouter();
  const { openSettings } = store;
  const [active, setActive] = useState<(typeof chapters)[number]>(chapters[0]);
  return (
    <main className="helpPage">
      <header className="helpHeader" data-window-drag>
        <Button icon="back" onClick={() => navigate(routes.library)}>{tr(ru.library)}</Button>
        <h1>{tr(ru.helpTitle)}</h1>
      </header>
      <div className="helpLayout">
        <nav className="helpNavigation" aria-label={tr(ru.helpTitle)}>
          {chapters.map((chapter) => (
            <Button key={chapter.id} icon={chapter.icon} variant={chapter.id === active.id ? "primary" : "ghost"}
              aria-current={chapter.id === active.id ? "page" : undefined} onClick={() => setActive(chapter)}>
              {tr(ru[chapter.title])}
            </Button>
          ))}
        </nav>
        <Card className="helpArticle" padding="lg">
          <article key={active.id} aria-labelledby="helpChapterTitle">
            <h2 id="helpChapterTitle">{tr(ru[active.title])}</h2>
            {active.paragraphs.map((key) => <p key={key}>{tr(ru[key])}</p>)}
            {"image" in active && <figure>
              <img src={`${import.meta.env.BASE_URL}help/${active.image}.jpg`} alt={tr(ru[active.title])} loading="lazy" />
              <figcaption>{tr(ru.helpScreenshot)}</figcaption>
            </figure>}
            {["audio", "models"].includes(active.id) && <Button icon="settings"
              onClick={() => openSettings(active.id === "audio" ? "audio" : "ai")}>
              {tr(ru.settings)}
            </Button>}
          </article>
        </Card>
      </div>
    </main>
  );
};

export default HelpPage;
