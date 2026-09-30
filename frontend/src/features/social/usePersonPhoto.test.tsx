import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { usePersonPhoto } from "./usePersonPhoto";

const mocks = vi.hoisted(() => ({
  photo: "data:image/webp;base64,bG9jYWw=",
  inbox: { type: "inbox", me: { accountId: "me" } } as const,
  avatar: vi.fn(),
}));

vi.mock("../../app/AppContext", () => ({
  useApp: () => ({ preferences: { profilePhoto: mocks.photo } }),
}));
vi.mock("./SocialContext", () => ({ useSocial: () => mocks.inbox }));
vi.mock("../../services/socialClient", () => ({
  socialClient: { avatar: mocks.avatar },
}));

beforeEach(() => mocks.avatar.mockReset());

it("uses the locally persisted photo for this profile after an app restart", () => {
  const { result } = renderHook(() => usePersonPhoto("me", 0));

  expect(result.current).toBe(mocks.photo);
  expect(mocks.avatar).not.toHaveBeenCalled();
});

it("still loads another person's photo from the social server", async () => {
  mocks.avatar.mockResolvedValue("data:image/png;base64,ZnJpZW5k");
  const { result } = renderHook(() => usePersonPhoto("friend", 4));

  await waitFor(() => expect(result.current).toBe("data:image/png;base64,ZnJpZW5k"));
  expect(mocks.avatar).toHaveBeenCalledWith("friend", 4);
});
