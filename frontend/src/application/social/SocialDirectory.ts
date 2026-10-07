import type { ParticipantPerson, RoomStay, SocialMe } from "../../contracts/social";

export interface SocialDirectoryPort {
  people(ids: string[]): Promise<ParticipantPerson[]>;
  avatar(accountId: string, version: number): Promise<string>;
  history(): Promise<RoomStay[]>;
  setAvatar(mime: string, data: string): Promise<SocialMe>;
}
