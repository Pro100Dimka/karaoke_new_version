from __future__ import annotations
from backend.processing.compute_policy import ComputeDevice, ExecutionContext

import threading
from types import SimpleNamespace
import urllib.error
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
import httpx

from backend.domain_errors import DependencyError
from backend.infrastructure.lrclib_provider import LrclibLyricsProvider
from backend.infrastructure.tekst_pesenok_provider import TekstPesenokLyricsProvider
from backend.infrastructure.pisni_provider import PisniLyricsProvider
from backend.lyrics.discovery import LyricsDiscovery, LyricsMatchPolicy
from backend.lyrics.ports import LyricLineTiming, LyricsCandidate
from backend.songs.domain import Language, Song, SongStatus, SourceState
from backend.songs.filename_metadata import UNKNOWN_ARTIST
from tests.fakes import FakeAiProvider, FakeLyricsProvider

EXECUTION = ExecutionContext(ComputeDevice.CPU, 1)

_ROWS = (
    '[{"trackName": "Кофе мой друг", "artistName": "Нервы", "duration": 188,'
    ' "syncedLyrics": "[00:10.50] Кофе мой друг\\n[00:14.00] Музыка мой драйв", "plainLyrics": "x"}]'
)


@pytest.mark.parametrize("credit", ["Взято с сайта", "Взято с сайта https://example.org/song"])
def test_ukrainian_catalog_removes_source_credit_before_alignment(credit: str) -> None:
    provider = PisniLyricsProvider(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                text=f'<meta property="og:title" content="O.Torvald - Ліхтарі">'
                f'<div class="desc-full">Перший рядок<br>{credit}<br>Другий рядок</div>',
            )
        )
    )
    result = provider.search(_song("Ліхтарі", "O.Torvald"), Language.AUTO, threading.Event())
    assert result[0].lyrics == "Перший рядок\nДругий рядок"


def test_ukrainian_catalog_fallback_finds_tagged_song_without_using_asr_as_the_lyrics() -> None:
    def respond(request):
        assert str(request.url) == "https://pisni.ua/otorvald-likhtari"
        return httpx.Response(
            200,
            text="""<meta property="og:title" content="O.Torvald - Ліхтарі">
            <div class="desc desc-full"><p>Перший тестовий рядок<br/>Другий рядок</p>
            <p>Третій рядок</p></div>""",
        )

    provider = PisniLyricsProvider(transport=httpx.MockTransport(respond))
    discovery = LyricsDiscovery(_NoSidecar(), (provider,), LyricsMatchPolicy())
    result = discovery.discover(
        _song("Ліхтарі", "O.Torvald", 233.8),
        Path("vocal.wav"),
        FakeAiProvider(),
        threading.Event(),
        online_enabled=True,
        execution=EXECUTION,
    )
    assert result.source == "PisniUA"
    assert result.lyrics == "Перший тестовий рядок\nДругий рядок\nТретій рядок"


def test_ukrainian_catalog_rejects_another_artist_and_respects_cancellation() -> None:
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(
            200,
            text="""<meta property="og:title" content="Other - Ліхтарі">
            <div class="desc desc-full">Unrelated text</div>""",
        )

    provider = PisniLyricsProvider(transport=httpx.MockTransport(respond))
    discovery = LyricsDiscovery(_NoSidecar(), (provider,), LyricsMatchPolicy())
    result = discovery.discover(
        _song("Ліхтарі", "O.Torvald"),
        Path("vocal.wav"),
        FakeAiProvider(),
        threading.Event(),
        online_enabled=True,
        execution=EXECUTION,
    )
    assert result.source == "ASR"
    cancel = threading.Event()
    cancel.set()
    assert not provider.search(_song("Ліхтарі", "O.Torvald"), Language.AUTO, cancel)
    assert len(requests) == 1


def _song(title: str, artist: str, duration: float | None = 188.0) -> Song:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    return Song(
        "s",
        title,
        artist,
        "id",
        SourceState.MANAGED,
        None,
        SongStatus.IMPORTED,
        1,
        2,
        now,
        now,
        duration=duration,
    )


class _Recorder:
    def __init__(self, *responses: str | Exception) -> None:
        self.urls: list[str] = []
        self._responses = list(responses)

    def __call__(self, url: str, timeout: float) -> str:
        self.urls.append(url)
        response = self._responses.pop(0) if self._responses else "[]"
        if isinstance(response, Exception):
            raise response
        return response


def test_searches_by_cleaned_title_and_artist_and_returns_plain_text() -> None:
    fetch = _Recorder(_ROWS)
    provider = LrclibLyricsProvider(fetch=fetch)

    result = provider.search(
        _song("Кофе мой друг (zaycev.net)", "Нервы"), Language.AUTO, threading.Event()
    )

    query = parse_qs(urlparse(fetch.urls[0]).query)
    assert query == {"track_name": ["Кофе мой друг"], "artist_name": ["Нервы"]}
    assert result[0].lyrics == "Кофе мой друг\nМузыка мой драйв"
    assert result[0].duration == 188.0
    assert [(hint.start, hint.text) for hint in result[0].timing_hints] == [
        (10.5, "Кофе мой друг"),
        (14.0, "Музыка мой драйв"),
    ]


def test_falls_back_to_title_only_search_when_the_artist_search_is_empty() -> None:
    fetch = _Recorder("[]", _ROWS)
    provider = LrclibLyricsProvider(fetch=fetch)

    result = provider.search(_song("Кофе мой друг", "Нервы"), Language.AUTO, threading.Event())

    assert "artist_name" not in urlparse(fetch.urls[1]).query
    assert len(result) == 1


def test_unknown_artist_is_not_sent() -> None:
    fetch = _Recorder(_ROWS)
    LrclibLyricsProvider(fetch=fetch).search(
        _song("Кофе мой друг", UNKNOWN_ARTIST), Language.AUTO, threading.Event()
    )
    assert "artist_name" not in urlparse(fetch.urls[0]).query


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (urllib.error.HTTPError("u", 429, "busy", None, None), "ProviderRateLimited"),
        (TimeoutError(), "ProviderTimeout"),
        (OSError("offline"), "ProviderUnavailable"),
        ("not json", "ProviderUnavailable"),
    ],
)
def test_failures_become_provider_dependency_errors(failure: Exception | str, code: str) -> None:
    provider = LrclibLyricsProvider(fetch=_Recorder(failure))
    with pytest.raises(DependencyError) as error:
        provider.search(_song("Title", "Artist"), Language.AUTO, threading.Event())
    assert error.value.code == code


class _NoSidecar:
    def read(self, source: Path) -> str | None:
        return None


def _discover(candidate: LyricsCandidate, song: Song) -> tuple[str, str]:
    discovery = LyricsDiscovery(
        _NoSidecar(), (FakeLyricsProvider([(candidate,)]),), LyricsMatchPolicy()
    )
    result = discovery.discover(
        song,
        Path("vocal.wav"),
        FakeAiProvider(),
        threading.Event(),
        online_enabled=True,
        execution=EXECUTION,
    )
    return result.lyrics, result.source


def test_catalog_names_that_differ_from_the_file_name_still_match() -> None:
    candidate = LyricsCandidate("catalog text", "Кофе мой друг", "Нервы", 190.0, "fake-lyrics")

    assert _discover(candidate, _song("Кофе мой Друг (zaycev.net)", "нервы")) == (
        "catalog text",
        "fake-lyrics",
    )


def test_same_song_lyrics_allow_a_shortened_audio_edit() -> None:
    candidate = LyricsCandidate("catalog text", "Не треба", "Скрябін", 230.0, "fake-lyrics")

    assert _discover(candidate, _song("Не треба", "Skryabin", 215.43)) == (
        "catalog text",
        "fake-lyrics",
    )


def test_a_different_song_is_rejected_so_the_model_transcribes() -> None:
    candidate = LyricsCandidate("other text", "Совсем другая песня", "Другой", 190.0, "fake-lyrics")

    lyrics, source = _discover(candidate, _song("Кофе мой друг", "Нервы"))

    assert source == "ASR"
    assert lyrics != "other text"


def test_plain_catalog_text_can_borrow_timings_from_a_matching_synced_version() -> None:
    plain = LyricsCandidate(
        "вступление первая строка вторая строка третья строка",
        "T",
        "A",
        20.0,
        "catalog",
    )
    timed = LyricsCandidate(
        "первая строка вторая строка третья строка",
        "T",
        "A",
        20.0,
        "catalog",
        (
            LyricLineTiming(10.0, "первая строка"),
            LyricLineTiming(14.0, "вторая строка"),
            LyricLineTiming(17.0, "третья строка"),
        ),
    )
    discovery = LyricsDiscovery(
        _NoSidecar(), (FakeLyricsProvider([(plain, timed)]),), LyricsMatchPolicy()
    )
    result = discovery.discover(
        _song("T", "A", 20.0),
        Path("vocal.wav"),
        FakeAiProvider(),
        threading.Event(),
        online_enabled=True,
        execution=EXECUTION,
    )

    assert result.lyrics == plain.lyrics
    assert result.timing_hints == timed.timing_hints


def test_a_dash_between_words_is_not_kept_as_a_word() -> None:
    rows = r'[{"trackName": "T", "artistName": "A", "plainLyrics": "Кофе – мой друг\nмузыка - мой драйв"}]'
    provider = LrclibLyricsProvider(fetch=_Recorder(rows))

    result = provider.search(_song("T", "A"), Language.AUTO, threading.Event())

    assert result[0].lyrics == "Кофе мой друг\nмузыка мой драйв"


def test_a_collaboration_is_also_searched_under_its_first_artist_and_by_free_text() -> None:
    fetch = _Recorder("[]", "[]", "[]", _ROWS)

    LrclibLyricsProvider(fetch=fetch).search(
        _song("Обормот (Remix)", "Смешарики, Марина Ланда"), Language.AUTO, threading.Event()
    )

    queries = [parse_qs(urlparse(url).query) for url in fetch.urls]
    assert queries[0]["artist_name"] == ["Смешарики, Марина Ланда"]
    assert queries[1]["artist_name"] == ["Смешарики"]
    assert "artist_name" not in queries[2]
    assert queries[3] == {"q": ["Смешарики Обормот"]}


def test_fallback_catalog_finds_balabama_lyrics_and_matches_transliterated_artist() -> None:
    unrelated_search = """
    <table class="tp-songs-table"><tbody>
      <tr><td><a href="/category/other/">Другой</a></td>
          <td><a href="https://tekst-pesenok.online/wrong-nadiya/">Надiя</a></td></tr>
    </tbody></table>
    """
    matching_search = """
    <table class="tp-songs-table"><tbody>
      <tr><td><a href="/category/balabama/">Балабама</a></td>
          <td><a href="https://tekst-pesenok.online/slova-pesni-balabama-nadiya/">Надiя</a></td></tr>
    </tbody></table>
    """
    wrong_page = r"""
    <script type="application/ld+json">
      {"@type":"MusicRecording","name":"Надiя","byArtist":{"name":"Другой"},
       "recordingOf":{"lyrics":{"text":"Неправильный текст"}}}
    </script>
    """
    page = r"""
    <script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
    <script type="application/ld+json">
      {"@type":"MusicRecording","name":"Надiя","byArtist":{"name":"Балабама"},
       "recordingOf":{"lyrics":{"text":"Под запретом шлю приветы,\nБез ответа — меня нету."}}}
    </script>
    """
    provider = TekstPesenokLyricsProvider(
        fetch=_Recorder(unrelated_search, wrong_page, matching_search, page)
    )
    song = _song("Надiя", "Balabama", duration=None)

    candidates = provider.search(song, Language.AUTO, threading.Event())

    assert len(candidates) == 1
    discovery = LyricsDiscovery(_NoSidecar(), (provider,), LyricsMatchPolicy())
    provider.search = lambda *_: candidates  # type: ignore[method-assign]
    result = discovery.discover(
        song,
        Path("vocal.wav"),
        FakeAiProvider(),
        threading.Event(),
        online_enabled=True,
        execution=EXECUTION,
    )
    assert candidates[0].provider_id == "TekstPesenok"
    assert (result.lyrics, result.source) == (
        "Под запретом шлю приветы,\nБез ответа — меня нету.",
        "TekstPesenok",
    )


def test_cyrillic_song_metadata_prevents_auto_asr_from_switching_to_english() -> None:
    class RecordingAi(FakeAiProvider):
        def __init__(self) -> None:
            super().__init__()
            self.languages: list[Language] = []

        def transcribe(
            self,
            vocal: Path,
            language: Language,
            cancel: threading.Event,
            *,
            execution: ExecutionContext,
        ) -> str:
            self.languages.append(language)
            return "Русский текст"

    ai = RecordingAi()
    discovery = LyricsDiscovery(_NoSidecar(), (), LyricsMatchPolicy())

    result = discovery.discover(
        _song("Надiя", "Балабама"),
        Path("vocal.wav"),
        ai,
        threading.Event(),
        online_enabled=False,
        execution=EXECUTION,
    )

    assert result.lyrics == "Русский текст"
    assert ai.languages == [Language.RUSSIAN]


class _TranscriptAi(FakeAiProvider):
    def __init__(self, text: str) -> None:
        super().__init__()
        self.text = text
        self.languages: list[Language] = []

    def transcribe(self, vocal, language, cancel, *, execution):
        self.languages.append(language)
        return self.text


@pytest.mark.parametrize("last_repeats", [1, 3])
@pytest.mark.parametrize("quiet_line_missed_by_asr", [False, True])
def test_catalog_omitted_middle_and_final_refrains_are_restored_from_performance(
    last_repeats,
    quiet_line_missed_by_asr,
):
    verse = ["Первый свет над городами", "Я иду домой сегодня"]
    refrain = ["Мы навстречу новым звёздам", "Наши голоса над морем"]
    bridge = ["Тихий дождь стучит по крышам", "Ты услышишь эти строки"]
    final = ["Утром я опять уеду", "Снова поезда уходят"]
    catalog = verse + refrain + bridge + final
    performed = verse + refrain + bridge + refrain + final + refrain * last_repeats
    heard = [line for line in performed if not quiet_line_missed_by_asr or line != final[0]]
    ai = _TranscriptAi(" ".join(heard))
    candidate = LyricsCandidate("\n".join(catalog), "T", "A", 188, "catalog")
    discovery = LyricsDiscovery(
        _NoSidecar(), (FakeLyricsProvider([(candidate,)]),), LyricsMatchPolicy()
    )
    result = discovery.discover(
        _song("T", "A"),
        Path("voice.wav"),
        ai,
        threading.Event(),
        online_enabled=True,
        execution=EXECUTION,
    )
    assert result.lyrics.splitlines() == performed
    assert "LyricsRepeatsRecovered" in result.warnings


@pytest.mark.parametrize(
    "text",
    [
        "Її голос лунає вночі\nМи зустрінемо ранок разом",
        "Є надія у наших серцях\nТи почуєш цю пісню знову",
    ],
)
def test_catalog_text_selects_ukrainian_for_audio_coverage_check(text):
    ai = _TranscriptAi(text)
    candidate = LyricsCandidate(text, "T", "A", 188, "catalog")
    result = LyricsDiscovery(
        _NoSidecar(), (FakeLyricsProvider([(candidate,)]),), LyricsMatchPolicy()
    ).discover(
        _song("T", "A"),
        Path("voice.wav"),
        ai,
        threading.Event(),
        online_enabled=True,
        execution=EXECUTION,
    )
    assert ai.languages == [Language.UKRAINIAN]
    assert result.lyrics == text


def test_no_repeat_is_invented_when_asr_misses_lines_or_hallucinates_other_text():
    text = "Первый свет над городами\nНаши голоса над морем\nСнова поезда уходят"
    ai = _TranscriptAi("Наши голоса над морем Thank you for watching please subscribe")
    candidate = LyricsCandidate(text, "T", "A", 188, "catalog")
    result = LyricsDiscovery(
        _NoSidecar(), (FakeLyricsProvider([(candidate,)]),), LyricsMatchPolicy()
    ).discover(
        _song("T", "A"),
        Path("voice.wav"),
        ai,
        threading.Event(),
        online_enabled=True,
        execution=EXECUTION,
    )
    assert result.lyrics == text


@pytest.mark.parametrize("vocal_result", ["partial", "strong"])
def test_original_mix_recovers_sung_repeats_missed_in_the_vocal_stem(
    tmp_path,
    vocal_result,
):
    import json
    from dataclasses import replace
    import numpy as np

    with np.load(Path(__file__).with_name("fixtures") / "chorus-entry.npz") as fixture:
        case = json.loads(str(fixture["recognition_metadata"]))
    original = tmp_path / "source.mp3"
    original.write_bytes(b"source audio read by the provider")
    vocal = tmp_path / "vocal.wav"
    calls = []

    class ComplementaryRecognition(_TranscriptAi):
        def transcribe(self, audio, *args, **kwargs):
            calls.append(audio)
            return case["mixed" if audio == original else vocal_result]["text"]

    candidate = LyricsCandidate(case["catalog"], "T", "A", 188, "catalog")
    result = LyricsDiscovery(
        _NoSidecar(),
        (FakeLyricsProvider([(candidate,)]),),
        LyricsMatchPolicy(),
    ).discover(
        replace(_song("T", "A"), source_path=original),
        vocal,
        ComplementaryRecognition(""),
        threading.Event(),
        online_enabled=True,
        execution=EXECUTION,
    )

    assert result.lyrics.splitlines() == case["expected"]
    assert calls == [vocal, original]


def test_partial_recognition_does_not_force_an_unrelated_catalog_phrase_into_a_chorus():
    from backend.lyrics.discovery import _complete_repeats

    lyrics = "\n".join(
        [
            "Let the sky fall",
            "When it crumbles",
            "We will stand tall",
            "Where you go I go",
            "What you see I see",
        ]
    )
    heard = "Let the sky fall when you come we will stand tall where you go I go what you see I see"
    assert _complete_repeats(lyrics, heard, threading.Event()) == lyrics


def test_catalog_search_keeps_artist_match_and_also_checks_title_versions():
    fetch = _Recorder(_ROWS, _ROWS.replace('"x"', '"full text"'))
    result = LrclibLyricsProvider(fetch=fetch).search(
        _song("Кофе мой друг", "Нервы"),
        Language.AUTO,
        threading.Event(),
    )
    assert len(fetch.urls) == 2
    assert "artist_name" not in parse_qs(urlparse(fetch.urls[1]).query)
    assert result


def test_title_search_survives_an_artist_lookup_outage():
    fetch = _Recorder(TimeoutError(), _ROWS)
    assert LrclibLyricsProvider(fetch=fetch).search(
        _song("Кофе мой друг", "Нервы"),
        Language.AUTO,
        threading.Event(),
    )


def test_online_abbreviation_does_not_replace_a_fuller_saved_ai_catalog():
    from backend.lyrics.codec import encode_document
    from backend.lyrics.domain import LyricsDocument

    lines = ["Первый свет над городами", "Наши голоса над морем", "Снова поезда уходят"]
    complete = "\n".join(lines + [lines[1]])
    baseline = encode_document(LyricsDocument("T", "A", 188, None, None, complete, ()))
    projects = SimpleNamespace(
        load_manifest=lambda *_: SimpleNamespace(provenance={"lyricsSource": "LRCLIB"}),
        read_text_artifact=lambda *_: baseline,
    )
    candidate = LyricsCandidate("\n".join(lines), "T", "A", 188, "catalog")
    result = LyricsDiscovery(
        _NoSidecar(),
        (FakeLyricsProvider([[candidate]]),),
        LyricsMatchPolicy(),
        projects=projects,
    ).discover(
        _song("T", "A"),
        Path("voice.wav"),
        _TranscriptAi(" ".join(lines)),
        threading.Event(),
        online_enabled=True,
        execution=EXECUTION,
    )
    assert result.lyrics == complete
    assert "LyricsCatalogCached" in result.warnings


def test_cached_catalog_does_not_reintroduce_the_publishers_credit():
    from backend.lyrics.codec import encode_document
    from backend.lyrics.domain import LyricsDocument

    baseline = encode_document(
        LyricsDocument(
            "T",
            "A",
            188,
            None,
            None,
            "Перший світ над містами\nВзято с сайта\nНаші голоси над морем",
            (),
        )
    )
    projects = SimpleNamespace(
        load_manifest=lambda *_: SimpleNamespace(provenance={"lyricsSource": "PisniUA"}),
        read_text_artifact=lambda *_: baseline,
    )
    result = LyricsDiscovery(_NoSidecar(), (), LyricsMatchPolicy(), projects=projects).discover(
        _song("T", "A"),
        Path("voice.wav"),
        _TranscriptAi("Перший світ над містами Наші голоси над морем"),
        threading.Event(),
        online_enabled=False,
        execution=EXECUTION,
    )
    assert "Взято" not in result.lyrics


@pytest.mark.parametrize(
    ("language", "number", "expected"),
    [
        ("Ukrainian", 100, "сто відсотків"),
        ("Ukrainian", 21, "двадцять один відсоток"),
        ("Russian", 12, "двенадцать процентов"),
        ("Russian", 24, "двадцать четыре процента"),
        ("English", 50, "fifty percent"),
    ],
)
def test_lyric_percentages_have_pronounceable_words_in_every_supported_language(
    language,
    number,
    expected,
):
    from backend.text_normalization import spell_lyric_percentages

    assert spell_lyric_percentages(f"{number}%!", language) == expected + "!"


def test_fuller_matching_text_is_found_despite_artist_alias_and_missing_asr_repeats():
    partial = "Перший світ над містами\nЯ з тобою на сто відсотків\nЗнову їду до моря"
    complete = partial + "\nЯ з тобою на 100%\nЧуєш? Я з тобою на 100%"
    candidates = [
        LyricsCandidate(partial, "T", "A", 188, "catalog"),
        LyricsCandidate(complete, "T", "Another spelling", 188, "catalog"),
        LyricsCandidate(complete * 2, "T", "A", 300, "catalog"),
    ]
    discovery = LyricsDiscovery(
        _NoSidecar(), (FakeLyricsProvider([candidates]),), LyricsMatchPolicy()
    )
    result = discovery.discover(
        _song("T", "A"),
        Path("voice.wav"),
        _TranscriptAi(partial),
        threading.Event(),
        online_enabled=True,
        execution=EXECUTION,
    )
    assert result.lyrics == complete.replace("100%", "сто відсотків")


def test_missed_short_adlib_does_not_duplicate_a_performed_refrain():
    from backend.lyrics.discovery import _complete_repeats

    lyrics = "Первый свет над городами\nНаши голоса над морем\nСлышишь наши голоса над морем"
    heard = "Первый свет над городами Наши голоса над морем Наши голоса над морем"
    assert _complete_repeats(lyrics, heard, threading.Event()) == lyrics


@pytest.mark.parametrize(
    ("verse", "short", "full", "bridge", "final", "replies"),
    [
        (
            "Первый свет над городами",
            "Наши голоса над морем",
            "А теперь слышны наши голоса над морем",
            "Снова поезда уходят",
            "Утром я опять уеду",
            ["Наши голоса над морем", "Наши голоса над морем", "А теперь наши голоса надморем"],
        ),
        (
            "На небі немає хвиль",
            "Твій на сто відсотків",
            "А тепер він твій на сто відсотків",
            "Бачу що все це було намарне",
            "Здається лиш final call",
            # Independent unprompted ASR on the original separated vocal, 161–176 s.
            ["Тріна стовитсотків", "Тріна стовитсотків", "А тепер твіна стовитсотків"],
        ),
    ],
)
def test_performed_full_reply_keeps_its_prefix_after_short_repeats(
    verse,
    short,
    full,
    bridge,
    final,
    replies,
):
    from backend.lyrics.discovery import _complete_repeats

    catalog = "\n".join([verse, full, short, bridge, short, short, final])
    # ASR merges words and misses one quiet word; the audible prefix still distinguishes
    # the full reply from its suffix, even though this transition is absent in the catalogue.
    heard = " ".join(
        [
            verse,
            full,
            short,
            bridge,
            *replies,
            final,
        ]
    )
    expected = "\n".join([verse, full, short, bridge, short, short, full, final])

    assert _complete_repeats(catalog, heard, threading.Event()) == expected


@pytest.mark.parametrize("extra_final", [False, True])
def test_recognition_order_cannot_invent_a_repeat_without_an_extra_performed_occurrence(
    extra_final,
):
    from backend.lyrics.discovery import _merge_lines

    # A recognizer missed the first short answer and attached a later one after two long lines.
    # Its two recognized long lines cannot justify adding a fifth to the four catalogued ones.
    keys = ["heldphrase", "quietanswer", "quietanswerquietanswer", "finalverse"]
    original = [0, 1, 0, 2, 3, 0, 0]
    heard = (0, 0, 1, 3, 3) if extra_final else (0, 0, 1, 3)
    expected = [0, 1, 0, 2, 3, 3, 0, 0] if extra_final else original

    assert _merge_lines(original, heard, keys) == expected


def test_a_fresh_catalog_recomputes_ai_repeats_instead_of_preserving_a_longer_bad_baseline():
    from backend.lyrics.codec import encode_document
    from backend.lyrics.domain import LyricsDocument

    lines = ["Первый свет над городами", "Наши голоса над морем", "Снова поезда уходят"]
    lyrics = "\n".join(lines)
    stale = lyrics + "\n" + lines[1]
    baseline = encode_document(LyricsDocument("T", "A", 188, None, None, stale, ()))
    projects = SimpleNamespace(
        load_manifest=lambda *_: SimpleNamespace(
            provenance={
                "lyricsSource": "catalog",
                "warnings": ["LyricsRepeatsRecovered"],
            }
        ),
        read_text_artifact=lambda *_: baseline,
    )
    hints = tuple(LyricLineTiming(start, line) for start, line in zip((10, 30, 50), lines))
    candidate = LyricsCandidate(lyrics, "T", "A", 188, "catalog", hints)
    result = LyricsDiscovery(
        _NoSidecar(),
        (FakeLyricsProvider([(candidate,)]),),
        LyricsMatchPolicy(),
        projects=projects,
    ).discover(
        _song("T", "A"),
        Path("voice.wav"),
        _TranscriptAi(lyrics),
        threading.Event(),
        online_enabled=True,
        execution=EXECUTION,
    )

    assert result.lyrics == lyrics
    assert result.timing_hints == hints


def test_recovering_a_true_repeat_keeps_unambiguous_catalog_timing_hints():
    lines = ["Первый свет над городами", "Наши голоса над морем", "Снова поезда уходят"]
    hints = tuple(LyricLineTiming(start, line) for start, line in zip((10, 30, 50), lines))
    candidate = LyricsCandidate("\n".join(lines), "T", "A", 188, "catalog", hints)
    result = LyricsDiscovery(
        _NoSidecar(),
        (FakeLyricsProvider([(candidate,)]),),
        LyricsMatchPolicy(),
    ).discover(
        _song("T", "A"),
        Path("voice.wav"),
        _TranscriptAi(" ".join(lines + [lines[1]])),
        threading.Event(),
        online_enabled=True,
        execution=EXECUTION,
    )

    assert result.lyrics.splitlines() == lines + [lines[1]]
    assert result.timing_hints == (hints[0], hints[2])


def test_cached_catalogue_preserves_independent_phrase_timing_without_a_new_lookup():
    from backend.lyrics.codec import encode_document
    from backend.lyrics.domain import LyricsDocument

    lyrics = "Наши голоса над морем"
    baseline = encode_document(LyricsDocument("T", "A", 188, None, None, lyrics, ()))
    projects = SimpleNamespace(
        load_manifest=lambda *_: SimpleNamespace(
            provenance={
                "lyricsSource": "catalog",
                "lyricsTimingHints": [{"start": 30, "text": lyrics}],
            }
        ),
        read_text_artifact=lambda *_: baseline,
    )

    result = LyricsDiscovery(_NoSidecar(), (), LyricsMatchPolicy(), projects=projects).discover(
        _song("T", "A"),
        Path("voice.wav"),
        _TranscriptAi(lyrics),
        threading.Event(),
        online_enabled=False,
        execution=EXECUTION,
    )

    assert result.timing_hints == (LyricLineTiming(30, lyrics),)


def test_catalog_outage_uses_saved_ai_baseline_and_still_recovers_performed_repeats():
    from backend.lyrics.codec import encode_document
    from backend.lyrics.domain import LyricsDocument

    lines = ["Первый свет над городами", "Наши голоса над морем", "Снова поезда уходят"]
    baseline = encode_document(LyricsDocument("T", "A", 188, None, None, "\n".join(lines), ()))
    projects = SimpleNamespace(
        load_manifest=lambda *_: SimpleNamespace(provenance={"lyricsSource": "LRCLIB"}),
        read_text_artifact=lambda *args: (
            baseline if args[-1] == "lyricsBaseline" else pytest.fail("Use AI baseline")
        ),
    )
    ai = _TranscriptAi(" ".join(lines + [lines[1]]))
    result = LyricsDiscovery(_NoSidecar(), (), LyricsMatchPolicy(), projects=projects).discover(
        _song("T", "A"),
        Path("voice.wav"),
        ai,
        threading.Event(),
        online_enabled=True,
        execution=EXECUTION,
    )
    assert result.lyrics.splitlines() == lines + [lines[1]]
    assert "LyricsCatalogCached" in result.warnings


@pytest.mark.parametrize("cached_other_version", [False, True])
def test_a_longer_other_recording_cannot_replace_the_matching_catalog_version(cached_other_version):
    from backend.lyrics.codec import encode_document
    from backend.lyrics.domain import LyricsDocument

    lines = ["Первый свет над городами", "Наши голоса над морем", "Снова поезда уходят"]
    text = "\n".join(lines)
    other = text + "\n" + lines[1]
    hints = tuple(LyricLineTiming(start, line) for start, line in zip((10, 30, 50), lines))
    candidates = [
        LyricsCandidate(other, "T", "A feat. Guest", 193, "catalog"),
        LyricsCandidate(text, "T", "A", 188, "catalog", hints),
    ]
    baseline = encode_document(LyricsDocument("T", "A", 188, None, None, other, ()))
    projects = (
        SimpleNamespace(
            load_manifest=lambda *_: SimpleNamespace(provenance={"lyricsSource": "catalog"}),
            read_text_artifact=lambda *_: baseline,
        )
        if cached_other_version
        else None
    )
    result = LyricsDiscovery(
        _NoSidecar(),
        (FakeLyricsProvider([candidates]),),
        LyricsMatchPolicy(),
        projects=projects,
    ).discover(
        _song("T", "A"),
        Path("voice.wav"),
        _TranscriptAi(text),
        threading.Event(),
        online_enabled=True,
        execution=EXECUTION,
    )

    assert result.lyrics == text
    assert result.timing_hints == hints
    assert result.source == FakeLyricsProvider.provider_id
