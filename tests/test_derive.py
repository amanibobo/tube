import pytest

from pipeline.derive import pairs_from_tracks, params_for, stats_from_tracks


def box(x, y, w, h):
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


def test_pairs_handle_contours_of_different_lengths():
    """Real masks give each contour its own point count; the pair table must still use polygon gaps."""
    hexagon = [[300, 110], [310, 100], [320, 110], [320, 130], [310, 140], [300, 130]]
    person = {"id": 1, "class": "person", "frames": [
        {"f": f, "bbox": [300, 100, 320, 140], "centroid": [310, 120], "contour": hexagon} for f in range(3)]}
    car = {"id": 2, "class": "car", "frames": [
        {"f": f, "bbox": [200 + 10 * f, 150, 300 + 10 * f, 190], "centroid": [250 + 10 * f, 170],
         "contour": box(200 + 10 * f, 150, 100, 40)} for f in range(3)]}
    tracks = [person, car]
    pairs = pairs_from_tracks(tracks, stats_from_tracks(tracks, 30, "top"), max_dist=120, view="top")
    assert list(pairs.f) == [0, 1, 2]
    assert list(pairs.dist) == pytest.approx([200 ** 0.5, 10.0, 10.0])


def test_params_scale_with_person_height():
    """Thresholds follow the median person height: close is 1.5 heights, speeds 50/130 and 20/130 per s."""
    person = {"class": "person", "frames": [{"bbox": [0, 0, 20, 65]}, {"bbox": [0, 0, 20, 65]}]}
    assert params_for([person]) == {"person_h": 65, "close_px": 97.5, "moving_speed": 25.0, "stop_speed": 10.0,
                                    "view": "oblique"}


def track(tid, cls, boxes):
    return {"id": tid, "class": cls, "frames": [
        {"f": f, "bbox": [x0, y0, x0 + w, y0 + h], "centroid": [x0 + w // 2, y0 + h // 2], "contour": box(x0, y0, w, h)}
        for f, (x0, y0, w, h) in enumerate(boxes)]}


def test_oblique_distance_runs_from_feet_to_the_vehicle_ground_line():
    """A person standing behind a bus whose roof overlaps their body is far away on the ground."""
    bus = track(2, "car", [(100, 100, 300, 120)] * 3)
    person = track(1, "person", [(200, 60, 20, 60)] * 3)
    tracks = [person, bus]
    top = pairs_from_tracks(tracks, stats_from_tracks(tracks, 30, "top"), 200, "top")
    oblique = pairs_from_tracks(tracks, stats_from_tracks(tracks, 30), 200)
    assert list(top.dist) == [0.0, 0.0, 0.0]
    assert list(oblique.dist) == [100.0, 100.0, 100.0]


def test_frames_where_the_person_is_mostly_inside_the_vehicle_are_skipped():
    car = track(2, "car", [(100, 100, 200, 100)] * 2)
    person = track(1, "person", [(150, 110, 20, 40), (290, 110, 20, 40)])
    tracks = [person, car]
    pairs = pairs_from_tracks(tracks, stats_from_tracks(tracks, 30, "top"), 200, "top")
    assert list(pairs.f) == [1]


def test_oblique_positions_are_ground_contact_points():
    person = track(1, "person", [(10, 20, 30, 60), (40, 20, 30, 60)])
    stats = stats_from_tracks([person], 30)
    assert [list(r) for r in stats[["cx", "cy"]].to_numpy()] == [[25.0, 80.0], [55.0, 80.0]]
    assert list(stats_from_tracks([person], 30, "top").cy) == [50.0, 50.0]


def test_frames_where_the_vehicle_is_mostly_hidden_are_skipped():
    """A car seen through a gap in a tree shows a sliver whose bottom is not where it meets the ground."""
    car = track(2, "car", [(100, 100, 200, 100)] * 3 + [(100, 150, 200, 20)])
    person = track(1, "person", [(150, 30, 20, 40)] * 4)
    tracks = [person, car]
    pairs = pairs_from_tracks(tracks, stats_from_tracks(tracks, 30, "top"), 200, "top")
    assert list(pairs.f) == [0, 1, 2]
