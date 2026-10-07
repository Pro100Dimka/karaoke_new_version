import type { SocialPerson, SocialRelation } from "../../contracts/social";

type FriendPort = {
  requestFriend(target: { accountId: string } | { friendCode: string }):
    Promise<{ relation: SocialRelation; person: SocialPerson }>;
  acceptFriend(id: string): Promise<void>;
  declineFriend(id: string): Promise<void>;
  cancelRequest(id: string): Promise<void>;
  removeFriend(id: string): Promise<void>;
};
type ClipboardPort = { copyText(value: string): Promise<void> };

/** Application intents for friend relationships and their shareable code. */
export class FriendRelationsCoordinator {
  constructor(private readonly friends: FriendPort, private readonly clipboard: ClipboardPort) {}

  requestByCode(code: string): Promise<{ relation: SocialRelation; person: SocialPerson }> {
    return this.friends.requestFriend({ friendCode: code });
  }
  async requestAccount(accountId: string): Promise<SocialRelation> {
    return (await this.friends.requestFriend({ accountId })).relation;
  }
  befriend(person: Pick<SocialPerson, "accountId" | "relation">): Promise<void> {
    return person.relation === "Incoming"
      ? this.friends.acceptFriend(person.accountId)
      : this.friends.requestFriend({ accountId: person.accountId }).then(() => undefined);
  }
  accept(id: string): Promise<void> { return this.friends.acceptFriend(id); }
  decline(id: string): Promise<void> { return this.friends.declineFriend(id); }
  cancel(id: string): Promise<void> { return this.friends.cancelRequest(id); }
  remove(id: string): Promise<void> { return this.friends.removeFriend(id); }
  copyCode(code: string): Promise<void> { return this.clipboard.copyText(code); }
}
