from __future__ import annotations
import re
import string
from functools import lru_cache
from types import MappingProxyType
import numpy as np
import uroman
from num2words import num2words
from torchaudio.pipelines import MMS_FA


_NON_LETTERS = re.compile(r"[^a-z']")


@lru_cache(maxsize=1)
def _romanizer() -> uroman.Uroman:
    return uroman.Uroman()


# Exact single-character Uroman outputs after filtering to the CTC alphabet.
# Other scripts and multi-character number expansions still use the full romanizer.
_COMMON_ROMANIZATION = MappingProxyType(
    {
        case: romanized
        for character, romanized in {
            **dict(zip(string.ascii_lowercase, string.ascii_lowercase)),
            **dict.fromkeys(string.punctuation + " \t\r\n’–—…", ""),
            "'": "'",
            "а": "a",
            "б": "b",
            "в": "v",
            "г": "g",
            "д": "d",
            "е": "e",
            "ё": "e",
            "ж": "zh",
            "з": "z",
            "и": "i",
            "й": "i",
            "к": "k",
            "л": "l",
            "м": "m",
            "н": "n",
            "о": "o",
            "п": "p",
            "р": "r",
            "с": "s",
            "т": "t",
            "у": "u",
            "ф": "f",
            "х": "kh",
            "ц": "ts",
            "ч": "ch",
            "ш": "sh",
            "щ": "shch",
            "ъ": "",
            "ы": "y",
            "ь": "",
            "э": "e",
            "ю": "yu",
            "я": "ya",
            "і": "i",
            "ї": "yi",
            "є": "ie",
            "ґ": "gh",
        }.items()
        for case in (character, character.upper())
    }
)


def _character_tokens(word: str, context: str = "") -> list[list[int]]:
    """The alphabet indices each character of ``word`` is pronounced with (none for marks such as ь or punctuation)."""
    dictionary = MMS_FA.get_dict(star=None)
    characters = list(word)
    number = re.fullmatch(r"(\d+)(\W*)", word)
    if number:
        text = context.casefold()
        locale = next(
            (
                key
                for key, present in {
                    "uk": any(char in "іїєґ" for char in text),
                    "ru": any("а" <= char <= "я" or char == "ё" for char in text),
                }.items()
                if present
            ),
            "en",
        )
        try:
            spoken = num2words(int(number[1]), lang=locale)
            boundaries = np.linspace(0, len(spoken), len(number[1]) + 1, dtype=int)
            characters = [spoken[first:last] for first, last in zip(boundaries, boundaries[1:])]
            characters.extend(number[2])
        except (OverflowError, ValueError):
            pass
    result: list[list[int]] = []
    for character in characters:
        romanized = _COMMON_ROMANIZATION.get(character)
        if romanized is None:
            romanized = _NON_LETTERS.sub(
                "", _romanizer().romanize_string(character, lang=None).lower()
            )
        result.append([dictionary[letter] for letter in romanized if letter in dictionary])
    return result
