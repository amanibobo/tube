from pipeline.chunks import Chunk, densify, frame_record, plan_chunks, stitch, to_tracks


def square(x, y, s=20):
    return [[x, y], [x + s, y], [x + s, y + s], [x, y + s]]


def raw(cls, f0, f1, x_at):
    return {"source_class": cls, "frames": [frame_record(f, square(x_at(f), 100), [x_at(f) + 10, 110])
                                            for f in range(f0, f1 + 1)]}


def test_plan_chunks_overlap_one_second_and_cover_the_clip():
    chunks = plan_chunks(30.0)
    assert [(c.start, c.duration) for c in chunks] == [(0.0, 13.0), (12.0, 13.0), (24.0, 6.0)]


def test_to_tracks_maps_sampled_frames_to_video_frames_and_full_resolution():
    objects = {"car": {"3": [[0, square(10, 10), [20, 20], 400], [5, square(15, 10), [25, 20], 400]]}}
    [t] = to_tracks(objects, Chunk(1, 12.0, 13.0), fps=30, scale=2.0, sample_fps=10)
    assert t["source_class"] == "car"
    assert [fr["f"] for fr in t["frames"]] == [360, 375]
    assert t["frames"][1]["contour"][0] == [30, 20] and t["frames"][1]["bbox"] == [30, 20, 70, 60]


def test_stitch_joins_the_same_object_across_the_overlap_and_keeps_others_apart():
    first = [raw("car", 0, 39, lambda f: f), raw("person", 0, 39, lambda f: 500)]
    second = [raw("car", 30, 60, lambda f: f), raw("car", 30, 60, lambda f: 900), raw("person", 30, 60, lambda f: 500)]
    tracks = stitch(first, second)
    assert len(tracks) == 3
    car, person, other = tracks
    assert [fr["f"] for fr in car["frames"]] == list(range(0, 61))
    assert [fr["f"] for fr in person["frames"]] == list(range(0, 61))
    assert other["frames"][0]["bbox"][0] == 900


def test_stitch_does_not_join_different_classes_or_disjoint_masks():
    first = [raw("car", 0, 39, lambda f: 0)]
    tracks = stitch(first, [raw("bicycle", 30, 60, lambda f: 0), raw("car", 30, 60, lambda f: 300)])
    assert [t["source_class"] for t in tracks] == ["car", "bicycle", "car"]
    assert len(tracks[0]["frames"]) == 40


def test_densify_fills_skipped_frames_along_the_centroid_path():
    frames = [frame_record(0, square(0, 0), [10, 10]), frame_record(3, square(30, 0), [40, 10])]
    dense = densify(frames, max_gap=4)
    assert [fr["f"] for fr in dense] == [0, 1, 2, 3]
    assert dense[1]["centroid"] == [20, 10] and dense[2]["contour"][0] == [20, 0]
    assert [fr["f"] for fr in densify(frames, max_gap=2)] == [0, 3]


def test_the_same_object_from_two_prompts_keeps_the_more_specific_class():
    from pipeline.build import build_tracks

    bike = raw("bicycle", 0, 59, lambda f: f)
    as_vehicle = raw("vehicle", 0, 59, lambda f: f + 1)
    car = raw("vehicle", 0, 59, lambda f: 600)
    wheel = {"source_class": "vehicle", "frames": [frame_record(f, square(f + 2, 102, 8), [f + 6, 106])
                                                   for f in range(60)]}
    assert build_tracks([wheel, bike], fps=30)[0]["class"] == "bicycle" and len(build_tracks([wheel, bike], 30)) == 1
    kept = build_tracks([as_vehicle, bike, car], fps=30)
    assert [(t["class"], t["frames"][0]["bbox"][0]) for t in kept] == [("bicycle", 0), ("car", 600)]
