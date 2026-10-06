import type { LibraryFilters } from "./LibraryActions";

/** The filters a library view chooses itself; sort order lives in the persisted preferences. */
export type LibraryViewFilters = Omit<LibraryFilters, "sort" | "direction">;

/** Survives navigation to Karaoke/Editor within one app session; deliberately not persisted across restarts. */
export const libraryViewState: {
  query: string;
  filters: LibraryViewFilters;
  scrollTop: number;
} = {
  query: "",
  filters: { status: "all", language: "all", duration: "all", artwork: "all" },
  scrollTop: 0,
};
