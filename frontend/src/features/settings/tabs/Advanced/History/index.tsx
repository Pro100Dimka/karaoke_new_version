import { useCallback, useEffect, useState } from "react";
import { Button, Card, DataTable, MessageBar, NeonWaves, Tabs } from "@ad-voice/ui";
import type { HistoryEventDto } from "../../../../../contracts/models";
import { useText } from "../../../../../i18n/useText";
import { pythonClient } from "../../../../../services/pythonClient";
import { eventsForTab, type HistoryTab } from "./historyModel";

const pageSize = 50;

/** Product events page by page, split into performances and processing. */
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
      setEvents(current => offset === 0 ? page.items : [...current, ...page.items]);
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
    void pythonClient.listSongs()
      .then(songs => setTitles(new Map(songs.map(song => [song.id, `${song.artist} — ${song.title}`]))))
      .catch(() => undefined);
  }, [load]);

  const songOf = (event: HistoryEventDto) => (event.songId && titles.get(event.songId)) || event.songId || "—";

  return (
    <Card border className="advancedHistoryCard" icon="list" title={t("history")} description={t("historyHint")}
      actions={<NeonWaves className="advancedArt" strands={20} />}>
      <div className="settingsStack">
        <Tabs<HistoryTab> size="sm" value={tab} onValueChange={setTab} items={[
          { value: "performances", label: t("historyPerformances") },
          { value: "processing", label: t("historyProcessing") },
        ]} />
        {failed && <MessageBar tone="error">{t("historyLoadFailed")}</MessageBar>}
        <DataTable<HistoryEventDto & Record<string, unknown>> dense maxHeight="18rem" loading={loading && events.length === 0}
          empty={t("historyEmpty")} rowKey={event => event.id}
          rows={eventsForTab(events, tab).map(event => ({ ...event }))}
          columns={[
            { key: "createdAt", title: t("historyColumnDate"),
              render: event => <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time> },
            { key: "songId", title: t("historyColumnSong"), render: songOf, value: songOf },
            { key: "kind", title: t("historyColumnKind") },
          ]} />
        {events.length < total && (
          <Button size="sm" icon="down" loading={loading} onClick={() => void load(events.length)}>{t("loadMore")}</Button>
        )}
      </div>
    </Card>
  );
};
