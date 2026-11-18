import { useCallback, useEffect, useState } from 'react';
import {
  fallback,
  object,
  optional,
  picklist,
  safeParse,
  string,
} from 'valibot';
import type { LibraryViewFilters } from './search-field';
import { readJson, writeJson } from '../../../../shared/storage/localStore';

const STORAGE_KEY = 'adVoice.libraryView';

const viewSchema = object({
  query: string(),
  filters: object({
    status: picklist([
      'all',
      'not-processed',
      'queued',
      'processing',
      'ready',
      'failed',
      'importing',
      'invalid',
    ]),
    language: picklist(['all', 'Auto', 'Ukrainian', 'Russian', 'English']),
    duration: picklist(['all', 'short', 'medium', 'long']),
    artwork: fallback(picklist(['all']), 'all'),
    playlist: optional(string(), 'all'),
  }),
});

export type LibraryView = {
  query: string;
  filters: LibraryViewFilters;
};

const defaultView = (): LibraryView => ({
  query: '',
  filters: {
    status: 'all',
    language: 'all',
    duration: 'all',
    artwork: 'all',
    playlist: 'all',
  },
});

const loadView = (): LibraryView => {
  const result = safeParse(viewSchema, readJson(STORAGE_KEY, 'session'));
  return result.success ? result.output : defaultView();
};

export const useLibraryView = () => {
  const [view, setView] = useState(loadView);

  useEffect(() => {
    writeJson(STORAGE_KEY, view, 'session');
  }, [view]);

  const setQuery = useCallback((query: string) => {
    setView((current) =>
      current.query === query ? current : { ...current, query },
    );
  }, []);

  const setViewFilters = useCallback(
    (update: (current: LibraryViewFilters) => LibraryViewFilters) => {
      setView((current) => {
        const filters = update(current.filters);
        return filters === current.filters ? current : { ...current, filters };
      });
    },
    [],
  );

  return { view, setQuery, setViewFilters };
};
