import { useCallback, useEffect, useState } from 'react';
import { object, picklist, safeParse, string } from 'valibot';
import type { LibraryViewFilters } from './search-field';

const STORAGE_KEY = 'adVoice.libraryView';

const viewSchema = object({
  query: string(),
  filters: object({
    status: picklist([
      'all', 'not-processed', 'queued', 'processing', 'ready',
      'failed', 'importing', 'invalid',
    ]),
    language: picklist(['all', 'Auto', 'Ukrainian', 'Russian', 'English']),
    duration: picklist(['all', 'short', 'medium', 'long']),
    artwork: picklist(['all', 'with', 'without']),
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
  },
});

const loadView = (): LibraryView => {
  try {
    const result = safeParse(
      viewSchema,
      JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null'),
    );
    if (result.success) return result.output;
  } catch {
    // Storage is optional.
  }
  return defaultView();
};

export const useLibraryView = () => {
  const [view, setView] = useState(loadView);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(view));
    } catch {
      // Library remains usable without storage.
    }
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
