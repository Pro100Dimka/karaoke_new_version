import { Spinner } from "../../shared/ui/Spinner";
import { Button, Tabs } from "../../theme/ui";
import { ListChecks } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { HistoryEventDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { pythonClient } from "../../services/pythonClient";
import { SettingsCard } from "./SettingsCard";
import { eventsForTab, type HistoryTab } from "./historyModel";

const pageSize = 50;

export const HistoryPanel = () => {
  const t = useText();
  const [tab, setTab] = useState<HistoryTab>("performances");
  const [events, setEvents] = useState<readonly HistoryEventDto[]>([]);
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const page = await pythonClient.history(pageSize, offset);
      setEvents(current => (offset === 0 ? page.items : [...current, ...page.items]));
      setTotal(page.total);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(0);
    void pythonClient
      .listSongs()
      .then(songs => setTitles(new Map(songs.map(song => [song.id, `${song.artist} — ${song.title}`]))))
      .catch(() => undefined);
  }, [load]);

  const visible = eventsForTab(events, tab);

  return (
    <SettingsCard icon={ListChecks} title={t("history")} description={t("historyHint")}>
      <Tabs<HistoryTab>
        value={tab}
        onChange={setTab}
        items={[
          { value: "performances", label: t("historyPerformances") },
          { value: "processing", label: t("historyProcessing") }
        ]}
      />
      {loading && <Spinner size={16} />}
      {failed && <p role="alert">{t("historyLoadFailed")}</p>}
      {!loading && !failed && visible.length === 0 && <p className="muted">{t("historyEmpty")}</p>}
      <ul className="historyList">
        {visible.map(event => (
          <li key={event.id}>
            <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
            <span>{(event.songId && titles.get(event.songId)) || event.songId || "—"}</span>
            <span>{event.kind}</span>
          </li>
        ))}
      </ul>
      {events.length < total && (
        <Button size="sm" variant="outlined" tone="neutral" disabled={loading} onClick={() => void load(events.length)}>
          {t("loadMore")}
        </Button>
      )}
    </SettingsCard>
  );
};
