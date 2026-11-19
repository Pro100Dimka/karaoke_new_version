"""Vocal returns follow the performed song sections, including repeated seeks."""

import pytest

from backend.recordings.studio_layer_types import VocalLayerRegion
from backend.recordings.studio_layer_timing import map_layer_regions
from backend.recordings.studio_layer_timing import source_pitch_points
from backend.ai.domain import PitchPoint


def _point(elapsed, source, rate=1, key=0):
    return dict(elapsedSeconds=elapsed, sourceSeconds=source, playbackRate=rate, keyShift=key)


def _region(start, end, **kwargs):
    return VocalLayerRegion(start, end, "octave", 0.2, semitones=-12, **kwargs)


def test_chorus_layers_follow_original_seek_map_and_only_performed_sections():
    regions = [_region(70, 74), _region(92, 94)]
    mapped = map_layer_regions(regions, [_point(0, 40), _point(5, 90)], 10, 120)
    assert [(r.start, r.end) for r in mapped] == [(7, 9)]
    assert mapped[0].semitones == -12


def test_speed_scales_section_and_delay_without_transposing_interval_again():
    mapped = map_layer_regions([_region(45, 47.5, delay_ms=40)], [_point(0, 40, 1.25, 3)], 10, 120)
    assert [(r.start, r.end) for r in mapped] == [(4, 6)]
    assert mapped[0].delay_ms == 32
    assert mapped[0].semitones == -12


def test_repeated_chorus_is_repeated_and_regions_are_split_at_seeks():
    mapped = map_layer_regions([_region(0, 8)], [_point(0, 0), _point(5, 0)], 10, 120)
    assert [(r.start, r.end) for r in mapped] == [(0, 5), (5, 10)]


def test_reference_end_and_recording_end_bound_returns():
    mapped = map_layer_regions([_region(8, 20)], [_point(0, 8)], 5, 10)
    assert [(r.start, r.end) for r in mapped] == [(0, 2)]


@pytest.mark.parametrize(
    "points",
    [[], [_point(1, 0)], [_point(0, 0, 0)], [_point(0, 0), _point(0, 20)]],
)
def test_untrusted_timeline_does_not_guess_effect_positions(points):
    assert map_layer_regions([_region(0, 20)], points, 10, 120) == []


def test_only_verified_pcm_offset_can_supply_a_missing_timeline():
    region = _region(2, 4)
    assert map_layer_regions([region], [], 10, 120, offset_result=(0.25, 0.8)) == []
    mapped = map_layer_regions([region], [], 10, 120, offset_result=(0.25, 0.95))
    assert [(r.start, r.end) for r in mapped] == [(1.75, 3.75)]


def test_regions_outside_the_source_do_not_leak_into_take():
    assert map_layer_regions([_region(45, 50)], [_point(0, 90)], 10, 120) == []


def test_cropped_pitch_uses_source_pcm_seconds_without_rate_or_key_applied_twice():
    points = [PitchPoint(0.5, 300, 0.95, True), PitchPoint(0.8, 310, 0.9, True)]
    result = source_pitch_points(points, [_point(0, 40, 1.25, 3)], 40, rebuilt=False)
    assert [point.time for point in result] == [40.5, 40.8]
    assert [point.frequency for point in result] == [300, 310]


def test_rebuilt_pitch_is_mapped_to_song_and_repeated_evidence_deduplicated():
    points = [
        PitchPoint(1, 300, 0.8, True),
        PitchPoint(3, 310, 0.7, True),
        PitchPoint(6, 320, 0.9, True),
        PitchPoint(11, 305, 0.99, True),
    ]
    result = source_pitch_points(
        points, [_point(0, 40), _point(5, 90), _point(10, 40)], 0, rebuilt=True
    )
    assert [(point.time, point.frequency) for point in result] == [(41, 305), (43, 310), (91, 320)]


def test_rebuilt_pitch_with_missing_timeline_is_unusable():
    assert source_pitch_points([PitchPoint(1, 300, 0.95, True)], [], 0, rebuilt=True) == ()
