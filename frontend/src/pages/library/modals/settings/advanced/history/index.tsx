import {
  Stack,
  Button,
  Card,
  DataTable,
  MessageBar,
  NeonWaves,
  Tabs,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import type { HistoryEventDto } from '../../../../../../contracts/models';
import { historyKindLabel, type HistoryTab } from './historyModel';

import { useHistory } from './useHistory';

/** Product events page by page, split into performances and processing. */
export const HistoryPanel = () => {
  useLocale();
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
    if (!event.songId) return '—';
    if (!catalog.titles) return catalog.failed ? tr('unavailable') : '—';
    return catalog.titles.get(event.songId) ?? tr('historySongRemoved');
  };
  const kindOf = (event: HistoryEventDto) => {
    const label = historyKindLabel(event.kind);
    return label ? tr(label) : event.kind;
  };

  return (
    <Card
      border
      className="advancedHistoryCard"
      style={{
        background: 'unset!important',
        flex: '1',
        boxShadow: 'unset!important',
      }}
      icon="list"
      title={tr('history')}
      description={tr('historyHint')}
      actions={<NeonWaves className="advancedArt" strands={20} stars={false} />}
    >
      <Stack gap={4}>
        <Tabs<HistoryTab>
          size="sm"
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'performances', label: tr('historyPerformances') },
            { value: 'processing', label: tr('historyProcessing') },
          ]}
        />
        {(failed || catalog.failed) && (
          <MessageBar
            tone="error"
            action={
              <Button size="sm" icon="refresh" onClick={retry}>
                {tr('retry')}
              </Button>
            }
          >
            {tr('historyLoadFailed')}
          </MessageBar>
        )}
        {(!failed || events.length > 0) && (
          <DataTable<HistoryEventDto & Record<string, unknown>>
            dense
            loading={loading && events.length === 0}
            empty={tr('historyEmpty')}
            rowKey={(event) => event.id}
            rows={events.map((event) => ({ ...event }))}
            columns={[
              {
                key: 'createdAt',
                title: tr('historyColumnDate'),
                width: '12rem',
                render: (event) => (
                  <time dateTime={event.createdAt}>
                    {new Date(event.createdAt).toLocaleString()}
                  </time>
                ),
              },
              {
                key: 'songId',
                title: tr('historyColumnSong'),
                render: songOf,
                value: songOf,
              },
              {
                key: 'kind',
                title: tr('historyColumnKind'),
                width: '15rem',
                render: kindOf,
                value: kindOf,
              },
            ]}
          />
        )}
        {events.length < total && (
          <Button size="sm" icon="down" loading={loading} onClick={loadMore}>
            {tr('loadMore')}
          </Button>
        )}
      </Stack>
    </Card>
  );
};
