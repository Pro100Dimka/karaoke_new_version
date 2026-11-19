# Search folding: investigation and implementation

## Initial read-only investigation

**Use a checked-in, generated full Unicode casefold mapping for the folding stage, applied per code point with an identity fallback. Native JavaScript casing is not a correct substitute.** The initial investigation made no product edits; the subsequently authorized implementation is documented below.

The backend computes `unicodedata.normalize('NFKC', value).strip().casefold()`. This investigation isolates the **NFKC + casefold stages without the whitespace policy**. Existing frontend query trimming is left unchanged. Generate a sparse mapping from the same supported Python runtime for every Unicode code point whose `chr(cp).casefold()` differs from `chr(cp)`. The installed Python 3.12.14 / Unicode 15.0.0 produces **1,530 mappings**, approximately **20 KB of compact JSON** with numeric code-point keys. This is complete generated data, not a hand-maintained list of German/Greek special cases, and requires no new runtime or network dependency.

The frontend folding operation would be conceptually:

```ts
Array.from(value.normalize('NFKC'), (char) =>
  casefold[char.codePointAt(0)!] ?? char,
).join('');
```

Do not use `toLocaleLowerCase`, whole-string `toLowerCase`, or upper-then-lower as a fallback, and do not add a second normalization after casefold: the backend does not perform that second normalization. Document the generating Python/Unicode version alongside the data.

## Evidence

Compared all **1,112,064 Unicode scalar values** against Python's NFKC + casefold operation, deliberately excluding `.strip()` so that this is not a whitespace-policy comparison. Native JS was Node 24.22.3 / Unicode 17.0 / ICU 78.3.

| Candidate | Scalar mismatches against Python NFKC + casefold |
| --- | ---: |
| Existing JS NFKC + locale lowercase | 370 |
| JS NFKC + uppercase + lowercase | 267 |
| JS NFKC + generated full casefold mapping | 37 |
| Native JS NFKC alone versus Python NFKC alone | 37 |

The generated fold gives `strasse` for both `Straße` and `STRASSE`, `οσ` for `ΟΣ`/`οσ`/`ος`, preserves dotless `ı`, and follows Python's uppercase Cherokee folding. Upper-then-lower fails a real substring case: query `ΟΣ` becomes `ος`, but title `ΟΣΑ` becomes `οσα`, so matching fails; full casefold produces query `οσ` and title `οσα`, which match.

## Exact limit

The full mapping aligns **case folding** with the backend's Unicode version. It cannot by itself promise exact equality of the whole normalization pipeline across different Unicode releases. All 37 remaining scalar mismatches arise from native JS NFKC handling characters that are unassigned in Python's Unicode 15.0, for example U+A7F1 and the newer outlined letters/digits. Exhausting individual code points also does not establish normalization equality for every multi-code-point sequence; newer combining classes can affect ordering.

Therefore the principled, small fix for the reported full-catalog search bug is the complete generated folding table, with this explicit pre-existing NFKC version boundary. A requirement for exact backend equality for every future Unicode string additionally requires matching/pinning the normalization data or using backend-produced search keys; it cannot honestly be met by a native casing one-liner.

Evidence files under `/workspace/scratch/726a7fe1e251`:

- `third-search-python-unicode-reference.json`: generated Python reference mappings and string samples.
- `third-search-unicode-full-results.json`: complete scalar mismatch lists and candidate results.
- `third-search-unicode-summary.log`: versions, counts, representative strings, and contextual substring reproduction.

No editor, processing, security, backend, or frontend product edits were made during that read-only investigation.

## Authorized implementation and final status

**Source frozen on 2026-11-19 at approximately 19:38 UTC.** The implementation uses the complete generated sparse table and per-code-point lookup in `normalizeSearch`, retaining native `NFKC` and existing caller trimming. It does not include a workaround for the 37 future-version normalization differences above and does not claim complete normalization-version equivalence.

Changed or added exactly these five files:

| File | Purpose |
| --- | --- |
| `frontend/src/shared/utils/format.ts` | Replace locale lowercasing with complete Unicode default casefold lookup |
| `frontend/src/shared/utils/searchCasefold.generated.json` | All 1,530 non-identity casefold mappings; Unicode version metadata; 36,053 bytes in formatted ASCII JSON |
| `frontend/scripts/generate-search-casefold.py` | Deterministic generation from Unicode 15.0.0 Python; `--check` verifies the exact checked-in data without writing |
| `frontend/src/shared/utils/format.search-folding.test.ts` | German sharp S/capital sharp S, Greek final/contextual sigma, Cherokee, dotted/dotless i, expanded Greek, supplementary-plane casing, and three NFKC controls |
| `frontend/src/pages/library/songs/useLibraryCatalog.search-folding.test.tsx` | Real catalog hook and real `selectLibrarySongs`: server matches remain visible when selection or playlist mode switches to complete-catalog filtering |

The hook regressions cover German matches in title, artist, and filename; Greek matches in title; and both selection and playlist transitions. They first establish that the server result is visible, then switch to the complete catalog and assert it remains present after loading. Neither `selectLibrarySongs` nor existing library-owner test/source files were modified or mocked.

### Actual RED, then focused GREEN

- RED before product edits: **2 files failed; 13 tests failed and 7 passed; exit 1**. Seven normalization assertions failed and all six catalog transitions dropped the previously visible match.
- Initial GREEN: **2 files / 20 tests passed; exit 0**.
- Final focused GREEN after the final source edit: **3 files / 34 tests passed; exit 0**, including the existing `useLibraryCatalog.test.tsx` regressions.
- Renderer typecheck: `tsc -b tsconfig.app.json --pretty false`, **exit 0**, after the final source edit.
- Prettier check for all new/changed TypeScript and generated JSON: **exit 0**.
- `python frontend/scripts/generate-search-casefold.py --check`: **exit 0**, verifies all **1,530 mappings** against Unicode 15.0.0 Python.
- Scoped `git diff --check`: **exit 0**.

Raw verification logs under `/workspace/scratch/726a7fe1e251`:

- `third-search-folding-red.log`
- `third-search-folding-green.log`
- `third-search-folding-focused-green.log`
- `third-search-folding-typecheck.log`
- `third-search-folding-format.log`
- `third-search-folding-format-check.log`
- `third-search-folding-generator-check.log`

### Frozen SHA-256

| File | SHA-256 |
| --- | --- |
| `frontend/src/shared/utils/format.ts` | `ac27de9f6960cf4e89abe704cf8d1342267f1d1124fee0e758224d3f98674cb2` |
| `frontend/src/shared/utils/format.search-folding.test.ts` | `499d02186a43eb500c0a598caa9c1733d66f3e25ee9ec6b548394fe0a688367f` |
| `frontend/src/shared/utils/searchCasefold.generated.json` | `1d39267f5aefdade61b8c766ab4702de680746c1f9bdd80563c4ec3d0ffd5c4d` |
| `frontend/src/pages/library/songs/useLibraryCatalog.search-folding.test.tsx` | `61a202f890b3229b2ac8bdf7733909114660aef8a82dd25821164a9e81524a74` |
| `frontend/scripts/generate-search-casefold.py` | `291a3879b1ccc8fa96ffcab6011128ff6db80387e898f7ebae44a3f66b56e6b7` |

No backend source/config, editor, processing, AD Master/studio/analysis, room audio, or existing frozen library-owner files were modified. No full frontend suite, commit, push, or PR was performed by this agent; the root owns the final whole-frontend gate and publication.
