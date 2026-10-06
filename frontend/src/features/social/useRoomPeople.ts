import { useEffect, useMemo, useState } from "react";
import type { RoomStateDto } from "../../contracts/models";
import type { SocialPerson, SocialRelation } from "../../contracts/social";
import { socialClient } from "../../services/socialClient";
import { useSocial } from "./SocialContext";

/**
 * Who the room's participants are as people: their photos, and what they are to this user. Asked
 * once whenever someone joins or leaves; friendships then follow the pushed inbox.
 */
export const useRoomPeople = (
  room: RoomStateDto | null,
): ReadonlyMap<string, SocialPerson> => {
  const inbox = useSocial();
  const [people, setPeople] = useState<ReadonlyMap<string, SocialPerson>>(
    new Map(),
  );
  const connected = inbox.type === "inbox";
  const participantKey = room
    ? room.participants
        .map((participant) => participant.id)
        .sort()
        .join(",")
    : "";

  useEffect(() => {
    if (!participantKey || !connected) return setPeople(new Map());
    let active = true;
    socialClient.people(participantKey.split(",")).then(
      (found) =>
        active &&
        setPeople(
          new Map(found.map((item) => [item.participantId, item.person])),
        ),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [participantKey, connected]);

  return useMemo(() => {
    if (inbox.type !== "inbox") return people;
    const known = (list: SocialPerson[]) =>
      new Map(list.map((person) => [person.accountId, person]));
    const friends = known(inbox.friends);
    const sent = known(inbox.outgoingRequests);
    const received = known(inbox.friendRequests);
    const relation = (person: SocialPerson): SocialRelation => {
      if (person.accountId === inbox.me.accountId) return "Self";
      if (friends.has(person.accountId)) return "Friend";
      if (sent.has(person.accountId)) return "Requested";
      return received.has(person.accountId) ? "Incoming" : "None";
    };
    return new Map(
      [...people].map(([participant, person]) => {
        const live = friends.get(person.accountId) ?? person;
        const avatarVersion =
          person.accountId === inbox.me.accountId
            ? inbox.me.avatarVersion
            : live.avatarVersion;
        return [
          participant,
          { ...live, avatarVersion, relation: relation(person) },
        ];
      }),
    );
  }, [inbox, people]);
};
