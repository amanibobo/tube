from server.plans import DEMO_PLANS


def tracks(resp):
    return {s["track_id"] for s in resp["highlight"]["segments"]}


def test_close_passes(ds, expected):
    resp = DEMO_PLANS["every time a person and a car got close"](ds)
    assert tracks(resp) == {t for p in expected["close_pairs"] for t in p}
    assert len(resp["highlight"]["list"]) == len(expected["close_pairs"])


def test_stopped_in_crosswalk_both_phrasings(ds, expected):
    for q in ("which cars stopped in the crosswalk", "which cars stopped inside the crosswalk"):
        assert tracks(DEMO_PLANS[q](ds)) == {expected["stopped_in_crosswalk"]["car"]}


def test_top_three(ds, expected):
    resp = DEMO_PLANS["top 3 most dangerous moments"](ds)
    want = expected["near_misses"][:3]
    assert len(resp["highlight"]["list"]) == 3
    for item, nm in zip(resp["highlight"]["list"], want, strict=True):
        assert item["label"].startswith(f"person {nm['person']} and car {nm['car']},")


def test_crossings_per_minute(ds, expected):
    resp = DEMO_PLANS["how many people crossed per minute"](ds)
    got = {i["label"]: i["score"] for i in resp["highlight"]["list"]}
    assert got == {f"minute {m}: {n}": n for m, n in expected["crossings_per_minute"].items()}
    assert tracks(resp) == set(expected["crossing_people"])


def test_fastest_car(ds, expected):
    resp = DEMO_PLANS["fastest car in the clip"](ds)
    assert tracks(resp) == {expected["fastest_car"]["car"]}
