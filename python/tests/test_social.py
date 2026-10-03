from __future__ import annotations

import base64
from contextlib import ExitStack
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from starlette.testclient import WebSocketTestSession

from backend.api.room_server_app import create_room_server_app

_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def _device(name: str) -> str:
    return f"{name:-<40}"


def _headers(name: str) -> dict[str, str]:
    return {"X-AD-Voice-Device": _device(name)}


def _open(client: TestClient, stack: ExitStack, name: str, **presence: str) -> WebSocketTestSession:
    socket = stack.enter_context(client.websocket_connect("/social/socket"))
    socket.send_json({"device": _device(name), "displayName": name, **presence})
    return socket


def _inbox(socket: WebSocketTestSession) -> dict[str, Any]:
    message: dict[str, Any] = socket.receive_json()
    assert message["type"] == "inbox"
    return message


def test_the_same_computer_is_the_same_person_and_another_is_someone_else() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client, ExitStack() as stack:
        first = _inbox(_open(client, stack, "anna"))["me"]
        again = _inbox(_open(client, stack, "anna"))["me"]
        other = _inbox(_open(client, stack, "boris"))["me"]

    assert first["accountId"] == again["accountId"]
    assert first["friendCode"] == again["friendCode"]
    assert other["accountId"] != first["accountId"]


def test_a_friend_request_by_code_is_pushed_and_accepting_it_befriends_both() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client, ExitStack() as stack:
        anna = _open(client, stack, "anna")
        boris = _open(client, stack, "boris")
        anna_me = _inbox(anna)["me"]
        boris_code = _inbox(boris)["me"]["friendCode"]

        sent = client.post(
            "/social/friends/requests",
            headers=_headers("anna"),
            json={"friendCode": boris_code.lower().replace("-", " ")},
        )
        request = _inbox(boris)
        _inbox(anna)
        accepted = client.post(
            f"/social/friends/requests/{anna_me['accountId']}/accept", headers=_headers("boris")
        )
        told = _inbox(anna)

    assert sent.json()["relation"] == "Requested"
    assert [person["displayName"] for person in request["friendRequests"]] == ["anna"]
    assert accepted.status_code == 204
    assert [friend["displayName"] for friend in told["friends"]] == ["boris"]
    assert told["friends"][0]["presence"] == "Online"
    assert [notice["kind"] for notice in told["notices"]] == ["FriendAccepted"]


def test_requests_sent_both_ways_make_friends_at_once() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client, ExitStack() as stack:
        anna_code = _inbox(_open(client, stack, "anna"))["me"]["friendCode"]
        boris_code = _inbox(_open(client, stack, "boris"))["me"]["friendCode"]
        client.post(
            "/social/friends/requests", headers=_headers("anna"), json={"friendCode": boris_code}
        )
        both = client.post(
            "/social/friends/requests", headers=_headers("boris"), json={"friendCode": anna_code}
        )

    assert both.json()["relation"] == "Friend"


def _friends(
    client: TestClient, stack: ExitStack
) -> tuple[WebSocketTestSession, WebSocketTestSession, str]:
    anna = _open(client, stack, "anna")
    boris = _open(client, stack, "boris")
    anna_id = _inbox(anna)["me"]["accountId"]
    boris_code = _inbox(boris)["me"]["friendCode"]
    client.post(
        "/social/friends/requests", headers=_headers("anna"), json={"friendCode": boris_code}
    )
    _inbox(boris)
    _inbox(anna)
    client.post(f"/social/friends/requests/{anna_id}/accept", headers=_headers("boris"))
    _inbox(anna)
    boris_id = _inbox(boris)["me"]["accountId"]
    return anna, boris, boris_id


def test_a_declined_room_invitation_is_answered_to_the_one_who_asked() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client, ExitStack() as stack:
        anna, boris, boris_id = _friends(client, stack)
        room = client.post(
            "/rooms", json={"participantId": "anna-seat", "displayName": "anna"}
        ).json()
        anna.send_json(
            {"displayName": "anna", "participantId": "anna-seat", "roomId": room["roomId"]}
        )
        _inbox(boris)  # anna is now in a room
        client.post(
            "/social/invites",
            headers=_headers("anna"),
            json={"accountId": boris_id, "roomId": room["roomId"]},
        )
        invited = _inbox(boris)
        invite_id = invited["invites"][0]["inviteId"]
        declined = client.post(f"/social/invites/{invite_id}/decline", headers=_headers("boris"))
        answer = _inbox(anna)

    assert invited["invites"][0]["sender"]["displayName"] == "anna"
    assert invited["friends"][0]["presence"] == "InRoom"
    assert declined.status_code == 204
    assert [(n["kind"], n["person"]["displayName"]) for n in answer["notices"]] == [
        ("InviteDeclined", "boris")
    ]


def test_a_friend_can_request_entry_only_from_the_host_of_the_room() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client, ExitStack() as stack:
        anna, boris, boris_id = _friends(client, stack)
        room = client.post(
            "/rooms", json={"participantId": "anna-seat", "displayName": "anna"}
        ).json()
        anna.send_json(
            {"displayName": "anna", "participantId": "anna-seat", "roomId": room["roomId"]}
        )
        friend_view = _inbox(boris)["friends"][0]

        requested = client.post(
            "/social/join-requests",
            headers=_headers("boris"),
            json={"accountId": friend_view["accountId"], "roomId": room["roomId"]},
        )
        host_view = _inbox(anna)

    assert friend_view["isRoomHost"] is True
    assert requested.status_code == 204
    assert [(notice["kind"], notice["person"]["displayName"]) for notice in host_view["notices"]] == [
        ("JoinRequested", "boris")
    ]


def test_an_accepted_invitation_gives_the_room_to_join() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client, ExitStack() as stack:
        anna, boris, boris_id = _friends(client, stack)
        room_id = client.post(
            "/rooms", json={"participantId": "anna-seat", "displayName": "anna"}
        ).json()["roomId"]
        anna.send_json({"displayName": "anna", "participantId": "anna-seat", "roomId": room_id})
        _inbox(boris)
        client.post(
            "/social/invites",
            headers=_headers("anna"),
            json={"accountId": boris_id, "roomId": room_id},
        )
        invite_id = _inbox(boris)["invites"][0]["inviteId"]
        accepted = client.post(f"/social/invites/{invite_id}/accept", headers=_headers("boris"))

    assert accepted.json() == {"roomId": room_id}


def test_only_friends_are_invited_and_only_into_the_room_one_is_in() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client, ExitStack() as stack:
        _open(client, stack, "anna")
        boris_id = _inbox(_open(client, stack, "boris"))["me"]["accountId"]
        stranger = client.post(
            "/social/invites", headers=_headers("anna"), json={"accountId": boris_id, "roomId": "x"}
        )

    assert stranger.status_code == 403


def test_room_history_tells_who_was_there_and_for_how_long() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client, ExitStack() as stack:
        anna = _open(client, stack, "anna", participantId="anna-seat")
        _open(client, stack, "boris", participantId="boris-seat")
        _inbox(anna)
        room_id = client.post(
            "/rooms", json={"participantId": "anna-seat", "displayName": "Anna"}
        ).json()["roomId"]
        client.post(
            f"/rooms/{room_id}/join", json={"participantId": "boris-seat", "displayName": "Boris"}
        )
        client.post(f"/rooms/{room_id}/leave", json={"participantId": "boris-seat"})
        stays = client.get("/social/history", headers=_headers("anna")).json()

    assert [stay["roomId"] for stay in stays] == [room_id]
    assert stays[0]["leftAt"] is None
    assert stays[0]["seconds"] >= 0
    person = stays[0]["people"][0]
    assert person["displayName"] == "Boris"
    assert person["person"]["relation"] == "None"


def test_a_profile_photo_is_kept_and_shown_to_others() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client, ExitStack() as stack:
        anna_id = _inbox(_open(client, stack, "anna"))["me"]["accountId"]
        _open(client, stack, "boris")
        saved = client.put(
            "/social/avatar",
            headers=_headers("anna"),
            json={"mime": "image/png", "data": base64.b64encode(_PNG).decode()},
        )
        shown = client.get(f"/social/avatars/{anna_id}", headers=_headers("boris")).json()
        rejected = client.put(
            "/social/avatar",
            headers=_headers("anna"),
            json={"mime": "image/png", "data": base64.b64encode(b"<svg/>").decode()},
        )

    assert saved.json()["avatarVersion"] == 1
    assert base64.b64decode(shown["data"]) == _PNG
    assert rejected.status_code == 400


def test_a_profile_photo_survives_a_server_restart(tmp_path: Path) -> None:
    database = tmp_path / "rooms.sqlite3"
    with TestClient(create_room_server_app(relay_port=0, room_database=database)) as client:
        anna_id = client.get("/social/me", headers=_headers("anna")).json()["accountId"]
        saved = client.put(
            "/social/avatar",
            headers=_headers("anna"),
            json={"mime": "image/png", "data": base64.b64encode(_PNG).decode()},
        )
        assert saved.json()["avatarVersion"] == 1

    with TestClient(create_room_server_app(relay_port=0, room_database=database)) as client:
        restored = client.get("/social/me", headers=_headers("anna")).json()
        shown = client.get(f"/social/avatars/{anna_id}", headers=_headers("anna")).json()

    assert restored["accountId"] == anna_id
    assert restored["avatarVersion"] == 1
    assert base64.b64decode(shown["data"]) == _PNG


def test_friends_survive_a_server_restart_and_move_with_the_transfer_code(tmp_path: Path) -> None:
    database = tmp_path / "rooms.sqlite3"
    with TestClient(create_room_server_app(relay_port=0, room_database=database)) as client:
        with ExitStack() as stack:
            _friends(client, stack)
        transfer_code = client.get("/social/me", headers=_headers("anna")).json()["transferCode"]
    with TestClient(create_room_server_app(relay_port=0, room_database=database)) as client:
        with ExitStack() as stack:
            still = _inbox(_open(client, stack, "anna"))
        moved = client.post(
            "/social/transfer", headers=_headers("new-pc"), json={"transferCode": transfer_code}
        ).json()
        with ExitStack() as stack:
            on_new_computer = _inbox(_open(client, stack, "new-pc"))

    assert [friend["displayName"] for friend in still["friends"]] == ["boris"]
    assert moved["accountId"] == still["me"]["accountId"]
    assert moved["transferCode"] != transfer_code
    assert [friend["displayName"] for friend in on_new_computer["friends"]] == ["boris"]
