import { desktopClient } from "../../../../services/desktopClient";
import { ru } from "../../../../i18n/messages.ru";
import { QueryProvider } from "../../../../test/QueryProvider";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProcessingJobDto, SongDto } from "../../../../contracts/models";
import { pythonClient } from "../../../../services/pythonClient";
import { ProcessingModal } from "./index";
import { ask, DialogView } from "../../../../providers/dialog";
import { clearStorage } from "../../../../shared/storage/localStore";

const recovery = vi.hoisted(() => ({ reset: vi.fn(), notify: vi.fn() }));
vi.mock("../../../../pages/editor/editorApi", () => ({
  editorApi: { reset: recovery.reset },
}));
vi.mock("../../../../providers/notifications", () => ({
  useNotify: () => recovery.notify,
}));


vi.mock("@neo-ui-kit/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("@neo-ui-kit/react")>(),
  NeonWaves: () => null,
}));

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("processingScroll") ? 2000 : 150;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1000);
});

afterEach(() => {
  cleanup();
  clearStorage();
  vi.restoreAllMocks();
});

const song = (id: string, title: string): SongDto => ({
  id,
  title,
  artist: "Artist",
  language: "Auto",
  status: "ready",
  durationSeconds: 60,
  createdAt: "2026-10-01T00:00:00Z",
  coverState: "Fallback",
  activeRevision: 1,
  projectFormatVersion: 2,
});

const job = (
  id: string,
  songId: string,
  state: ProcessingJobDto["state"],
): ProcessingJobDto => ({
  id,
  songId,
  type: "SongProcessing",
  state,
  stage: "ProjectValidationPublication",
  progress: state === "completed" ? 100 : 0,
});

it("never retries or resets a failed existing song", async () => {
  const existing = song("existing", "Existing song");
  vi.spyOn(pythonClient, "listJobs").mockResolvedValue([
    {
      ...job("failed", existing.id, "failed"),
      error: {
        code: "ManualLyricsConflict",
        message: "Manual edits",
        source: "python",
      },
    },
  ]);
  render(
    <QueryProvider application>
      <ProcessingModal
        open
        songs={[existing]}
        onClose={vi.fn()}


        onPlay={vi.fn()}
      />
    </QueryProvider>,
  );
  const card = (await screen.findByText("Artist — Existing song")).closest(
    "li",
  )!;
  expect(
    within(card).queryByRole("button", {
      name: /retry|resetLyricsAndReprocess/i,
    }),
  ).toBeNull();
});

it("disables starting completed songs from the processing queue while the PC is busy", async () => {
  const ready = song("ready", "Ready song");
  vi.spyOn(pythonClient, "listJobs").mockResolvedValue([
    job("done", ready.id, "completed"),
  ]);
  const onPlay = vi.fn();
  const props = {
    open: true,
    songs: [ready],
    onClose: vi.fn(),
    onCancel: vi.fn(),
    onOpenFolder: vi.fn(),
    onPlay,
  };
  const view = render(
    <QueryProvider application>
      <ProcessingModal {...props} playbackDisabled />
    </QueryProvider>,
  );
  const play = await screen.findByRole("button", { name: "Запустить караоке" });
  expect(play).toBeDisabled();
  fireEvent.click(play);
  expect(onPlay).not.toHaveBeenCalled();
  view.rerender(
    <QueryProvider application>
      <ProcessingModal {...props} />
    </QueryProvider>,
  );
  expect(screen.getByRole("button", { name: "Запустить караоке" })).toBeEnabled();
});

it("keeps baseline recovery out of the queue after a manual-edit conflict", async () => {
  const existing = song("existing", "Edited song");
  vi.spyOn(pythonClient, "listJobs").mockResolvedValue([
    {
      ...job("manual-job", existing.id, "failed"),
      timingOperation: "lyrics",
      error: {
        code: "ManualLyricsConflict",
        message: "Manual edits exist",
        source: "python",
      },
    },
  ]);
  render(
    <QueryProvider application>
      <ProcessingModal
        open
        songs={[existing]}
        onClose={vi.fn()}


        onPlay={vi.fn()}
      />
    </QueryProvider>,
  );
  const card = (await screen.findByText("Artist — Edited song")).closest("li")!;
  expect(
    within(card).queryByRole("button", { name: "Вернуться к AI и пересчитать" }),
  ).toBeNull();
});

it.each(["ManualLyricsConflict", "ProcessFailure"])(
  "does not offer a reset or retry after %s",
  async (code) => {
    const existing = song("existing", "Edited song");
    vi.spyOn(pythonClient, "listJobs").mockResolvedValue([
      {
        ...job("manual-job", existing.id, "failed"),
        timingOperation: "lyrics",
        error: { code, message: "Processing failed", source: "python" },
      },
    ]);
    recovery.reset.mockReset().mockResolvedValue(2);
    render(
      <QueryProvider application>
        <>
          <DialogView />
          <ProcessingModal
            open
            songs={[existing]}
            onClose={vi.fn()}


            onPlay={vi.fn()}
          />
        </>
      </QueryProvider>,
    );
    const card = (await screen.findByText("Artist — Edited song")).closest(
      "li",
    )!;
    expect(
      within(card).queryByRole("button", {
        name: /retry|resetLyricsAndReprocess/,
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("Диалог", { name: "Вернуться к AI-разметке?" }),
    ).toBeNull();
    expect(recovery.reset).not.toHaveBeenCalled();
  },
);

it("keeps a failed lyric job visible without a restart control", async () => {
  const existing = song("existing", "Existing song");
  vi.spyOn(pythonClient, "listJobs").mockResolvedValue([
    {
      ...job("lyrics-job", existing.id, "failed"),
      timingOperation: "lyrics",
    },
  ]);
  render(
    <QueryProvider application>
      <ProcessingModal
        open
        songs={[existing]}
        onClose={vi.fn()}


        onPlay={vi.fn()}
      />
    </QueryProvider>,
  );
  const card = (await screen.findByText("Artist — Existing song")).closest(
    "li",
  )!;
  expect(within(card).queryByRole("button", { name: "Повторить" })).toBeNull();
});

it("connects every processing queue control to an action", async () => {
  const songs = [
    song("done", "Done song"),
    song("queued-a", "Queued A"),
    song("queued-b", "Queued B"),
    song("failed", "Failed song"),
    song("active", "Active song"),
  ];
  vi.spyOn(pythonClient, "listJobs").mockResolvedValue([
    job("job-done", "done", "completed"),
    job("job-queued-a", "queued-a", "queued"),
    job("job-queued-b", "queued-b", "queued"),
    job("job-failed", "failed", "failed"),
    job("job-active", "active", "processing"),
  ]);
  const onOpenFolder = vi.spyOn(desktopClient, "revealProject").mockResolvedValue(undefined);
  const onPlay = vi.fn();
  const onCancel = vi.spyOn(pythonClient, "cancelProcessing").mockResolvedValue(undefined);

  render(
    <QueryProvider application>
      <ProcessingModal
        open
        songs={songs}
        onClose={vi.fn()}


        onPlay={onPlay}
      />
      ,
    </QueryProvider>,
  );

  const doneCard = (await screen.findByText("Artist — Done song")).closest(
    "li",
  )!;
  fireEvent.click(
    within(doneCard).getByRole("button", { name: "Действия с задачей" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Открыть папку" }));
  fireEvent.click(within(doneCard).getByRole("button", { name: "Запустить караоке" }));
  expect(onOpenFolder).toHaveBeenCalledWith(songs[0]?.id, songs[0]?.activeRevision);
  expect(onPlay).toHaveBeenCalledWith(songs[0]);

  const activeCard = screen.getByText("Artist — Active song").closest("li")!;
  fireEvent.click(within(activeCard).getByRole("button", { name: "Отмена" }));
  fireEvent.click(screen.getByRole("button", { name: "Остановить" }));
  expect(onCancel).toHaveBeenCalledWith("job-active");

  const failedCard = screen.getByText("Artist — Failed song").closest("li")!;
  expect(
    within(failedCard).queryByRole("button", { name: "Повторить" }),
  ).toBeNull();

  const queuedBCard = screen.getByText("Artist — Queued B").closest("li")!;
  expect(within(queuedBCard).queryByRole("button", { name: "Выше в очереди" })).toBeNull();
  const titles = screen
    .getAllByRole("listitem")
    .map((item) => item.querySelector("strong")?.textContent);
  expect(titles.indexOf("Artist — Queued B")).toBeGreaterThan(
    titles.indexOf("Artist — Queued A"),
  );

  fireEvent.click(
    within(doneCard).getByRole("button", { name: "Действия с задачей" }),
  );
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(
    screen.getByRole("menuitem", { name: "Сведения о задаче" }),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Информация о диске" }));
  expect(
    screen.getByRole("dialog", { name: "Место на диске" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Готово" }));

  fireEvent.click(
    screen
      .getByRole("button", { name: "Очистить" })
      .parentElement!.querySelector(".ad-split-button-trigger")!,
  );
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Завершённые" }),
  );
  const clearDialog = screen.getByRole("dialog", {
    name: "Очистить завершённые задачи?",
  });
  fireEvent.click(
    within(clearDialog).getByRole("button", { name: "Очистить" }),
  );
  await waitFor(() =>
    expect(screen.queryByText("Artist — Done song")).not.toBeInTheDocument(),
  );
});

it.each([
  ["processingClearCompleted", ["completed"]],
  ["processingClearFailed", ["failed", "interrupted"]],
  [
    "processingClearAll",
    [
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "queued",
      "processing",
      "cancelling",
    ],
  ],
] as const)(
  "clears only the selected group through %s without cancelling processing",
  async (choice, removed) => {
    const states = [
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "queued",
      "processing",
      "cancelling",
    ] as const;
    const songs = states.map((state) => song(state, state));
    vi.spyOn(pythonClient, "listJobs").mockResolvedValue(
      states.map((state) => job(`job-${state}`, state, state)),
    );
    const onCancel = vi.spyOn(pythonClient, "cancelProcessing").mockResolvedValue(undefined);
    render(
      <QueryProvider application>
        <ProcessingModal
          open
          songs={songs}
          onClose={vi.fn()}


          onPlay={vi.fn()}
        />
      </QueryProvider>,
    );
    await screen.findByText("Artist — completed");
    fireEvent.click(
      screen
        .getByRole("button", { name: "Очистить" })
        .parentElement!.querySelector(".ad-split-button-trigger")!,
    );
    for (const label of [
      "processingClearCompleted",
      "processingClearFailed",
      "processingClearAll",
    ])
      expect(screen.getByRole("menuitem", { name: ru[label as keyof typeof ru] })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: ru[choice] }));
    const confirmation = screen
      .getAllByRole("dialog")
      .find((dialog) => dialog.classList.contains("processingNotice"))!;
    if (choice === "processingClearAll")
      expect(
        within(confirmation).getByText("Из списка будут убраны все задачи (7). Запущенная обработка продолжится. Песни и файлы сохранятся."),
      ).toBeInTheDocument();
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Очистить" }),
    );
    await waitFor(() => {
      for (const state of states) {
        const title = screen.queryByText(`Artist — ${state}`);
        expect(Boolean(title)).toBe(!removed.some((value) => value === state));
      }
    });
    expect(onCancel).not.toHaveBeenCalled();
  },
);

it("shows pipeline steps without the redundant overall progress bar or percentage", async () => {
  const existing = song("active", "Active song");
  vi.spyOn(pythonClient, "listJobs").mockResolvedValue([
    {
      ...job("job-active", existing.id, "processing"),
      stage: "MusicAnalysis",
      progress: 42,
    },
  ]);
  render(
    <QueryProvider application>
      <ProcessingModal
        open
        songs={[existing]}
        onClose={vi.fn()}


        onPlay={vi.fn()}
      />
    </QueryProvider>,
  );
  const card = (await screen.findByText("Artist — Active song")).closest("li")!;
  expect(within(card).queryByRole("progressbar")).not.toBeInTheDocument();
  expect(within(card).queryByText("42%")).not.toBeInTheDocument();
  expect(within(card).getByText("Подготовка")).toBeInTheDocument();
  expect(within(card).queryByText("MusicAnalysis")).not.toBeInTheDocument();
});

it("shows all pipeline steps and marks the actual current step", async () => {
  vi.spyOn(pythonClient, "listJobs").mockResolvedValue([
    {
      ...job("steps", "active", "processing"),
      stage: "ForcedAlignment",
      progress: 60,
    },
  ]);
  render(
    <QueryProvider application>
      <ProcessingModal
        open
        songs={[song("active", "Steps")]}
        onClose={vi.fn()}


        onPlay={vi.fn()}
      />
    </QueryProvider>,
  );
  const card = (await screen.findByText("Artist — Steps")).closest("li")!;
  const steps = within(card).getByRole("list", {
    name: "Этап",
  });
  expect(within(steps).getAllByRole("listitem")).toHaveLength(5);
  expect(
    within(steps).getByText("Текст").closest("li"),
  ).toHaveAttribute("aria-current", "step");
  expect(
    within(steps).getByText("Подготовка").closest("li"),
  ).toHaveAttribute("data-state", "done");
});

it("uses the kit split button for clearing completed jobs and choosing another group", async () => {
  vi.spyOn(pythonClient, "listJobs").mockResolvedValue([
    job("done", "done", "completed"),
  ]);
  render(
    <QueryProvider application>
      <ProcessingModal
        open
        songs={[song("done", "Done")]}
        onClose={vi.fn()}


        onPlay={vi.fn()}
      />
    </QueryProvider>,
  );
  await screen.findByText("Artist — Done");
  const clear = screen.getByRole("button", { name: "Очистить" });
  expect(clear.closest(".ad-split-button")).not.toBeNull();
  fireEvent.click(clear);
  expect(
    screen.getByRole("dialog", { name: "Очистить завершённые задачи?" }),
  ).toBeInTheDocument();
});

it("settles superseded confirmation and pending confirmation on unmount without a provider", async () => {
  const view = render(<DialogView />);
  const request = { title: "Confirm", body: "Continue?", actions: [{ id: "yes", label: "Yes" }] };
  let first!: Promise<string | null>;
  let second!: Promise<string | null>;
  act(() => { first = ask(request); second = ask(request); });
  await expect(first).resolves.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Yes" }));
  await expect(second).resolves.toBe("yes");
  let last!: Promise<string | null>;
  act(() => { last = ask(request); });
  view.unmount();
  await expect(last).resolves.toBeNull();
});
