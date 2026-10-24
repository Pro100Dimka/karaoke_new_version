import {
  Button,
  Card,
  DataTable,
  MessageBar,
  NeonWaves,
  Tabs,
} from "@neo-ui-kit/react";
import type { HistoryEventDto } from "../../../../../contracts/models";
import { useText } from "../../../../../i18n/useText";
import { historyKindLabel, type HistoryTab } from "./model/historyModel";

import { useHistory } from "./hooks/useHistory";

/** Product events page by page, split into performances and processing. */
export const HistoryPanel = () => {
  const t = useText();
  const {
    tab,
    events,
    total,
    loading,
    failed,
    catalog,
    loadMore,
    setTab,
    retry,
  } = useHistory();
  const songOf = (event: HistoryEventDto) => {
    if (!event.songId) return "—";
    if (!catalog.titles) return catalog.failed ? t("unavailable") : "—";
    return catalog.titles.get(event.songId) ?? t("historySongRemoved");
  };
  const kindOf = (event: HistoryEventDto) => {
    const label = historyKindLabel(event.kind);
    return label ? t(label) : event.kind;
  };

  return (
    <Card
      border
      className="advancedHistoryCard"
      style={{
        background: "unset!important",
        flex: "1",
        boxShadow: "unset!important",
      }}
      icon="list"
      title={t("history")}
      description={t("historyHint")}
      actions={<NeonWaves className="advancedArt" strands={20} stars={false} />}
    >
      <div className="settingsStack">
        <Tabs<HistoryTab>
          size="sm"
          value={tab}
          onValueChange={setTab}
          items={[
            { value: "performances", label: t("historyPerformances") },
            { value: "processing", label: t("historyProcessing") },
          ]}
        />
        {(failed || catalog.failed) && (
          <MessageBar
            tone="error"
            action={
              <Button size="sm" icon="refresh" onClick={retry}>
                {t("retry")}
              </Button>
            }
          >
            {t("historyLoadFailed")}
          </MessageBar>
        )}
        {(!failed || events.length > 0) && (
          <DataTable<HistoryEventDto & Record<string, unknown>>
            dense
            loading={loading && events.length === 0}
            empty={t("historyEmpty")}
            rowKey={(event) => event.id}
            rows={events.map((event) => ({ ...event }))}
            columns={[
              {
                key: "createdAt",
                title: t("historyColumnDate"),
                width: "12rem",
                render: (event) => (
                  <time dateTime={event.createdAt}>
                    {new Date(event.createdAt).toLocaleString()}
                  </time>
                ),
              },
              {
                key: "songId",
                title: t("historyColumnSong"),
                render: songOf,
                value: songOf,
              },
              {
                key: "kind",
                title: t("historyColumnKind"),
                width: "15rem",
                render: kindOf,
                value: kindOf,
              },
            ]}
          />
        )}
        {events.length < total && (
          <Button size="sm" icon="down" loading={loading} onClick={loadMore}>
            {t("loadMore")}
          </Button>
        )}
      </div>
    </Card>
  );
};
