import { useEffect, useRef, useState } from "react";
import type { HistoryEventDto } from "../../../../../../contracts/models";
import { useSettingsBackend } from "../../../../SettingsProvider";
import { historyKinds, type HistoryTab } from "../model/historyModel";

const pageSize = 50;

/** History pages and their title catalog have independent requests and retries. */
export const useHistory = () => {
  const backend = useSettingsBackend();
  const [query, setQuery] = useState({
    tab: "performances" as HistoryTab,
    offset: 0,
  });
  const [page, setPage] = useState({
    events: [] as readonly HistoryEventDto[],
    total: 0,
    loading: true,
    failed: false,
  });
  const [catalog, setCatalog] = useState({
    titles: null as ReadonlyMap<string, string> | null,
    failed: false,
  });
  const [titlesAttempt, setTitlesAttempt] = useState(0);
  const source = useRef(backend);

  useEffect(() => {
    let active = true;
    const offset = source.current === backend ? query.offset : 0;
    source.current = backend;
    setPage((current) => ({
      events: offset ? current.events : [],
      total: offset ? current.total : 0,
      loading: true,
      failed: false,
    }));
    void Promise.resolve()
      .then(() => backend.history(pageSize, offset, historyKinds[query.tab]))
      .then((result) => {
        if (active)
          setPage((current) => ({
            events: offset
              ? [...current.events, ...result.items]
              : result.items,
            total: result.total,
            loading: false,
            failed: false,
          }));
      })
      .catch(() => {
        if (active)
          setPage((current) => ({ ...current, loading: false, failed: true }));
      });
    return () => {
      active = false;
    };
  }, [backend, query]);

  useEffect(() => {
    let active = true;
    setCatalog({ titles: null, failed: false });
    void Promise.resolve()
      .then(() => backend.listSongs())
      .then((songs) => {
        if (active)
          setCatalog({
            titles: new Map(
              songs.map((song) => [song.id, `${song.artist} — ${song.title}`]),
            ),
            failed: false,
          });
      })
      .catch(() => {
        if (active) setCatalog({ titles: null, failed: true });
      });
    return () => {
      active = false;
    };
  }, [backend, titlesAttempt]);

  const loadMore = () =>
    setQuery((current) => ({ ...current, offset: page.events.length }));
  const setTab = (tab: HistoryTab) => {
    if (tab !== query.tab) setQuery({ tab, offset: 0 });
  };
  const retry = () => {
    if (page.failed) loadMore();
    if (catalog.failed) setTitlesAttempt((attempt) => attempt + 1);
  };

  return { tab: query.tab, ...page, catalog, loadMore, setTab, retry };
};
