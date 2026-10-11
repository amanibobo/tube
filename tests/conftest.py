import json
import shutil
from pathlib import Path

import pytest

from server.tools import load_dataset

SYNTH = Path(__file__).resolve().parent.parent / "data" / "synthetic"


@pytest.fixture(scope="session", autouse=True)
def synthetic_data():
    if not (SYNTH / "expected.json").exists():
        pytest.exit("run `python -m pipeline.synth` first", returncode=1)


@pytest.fixture
def expected():
    return json.loads((SYNTH / "expected.json").read_text())


@pytest.fixture
def ds(expected):
    """Synthetic data with the scripted crosswalk, whatever a running server has done to zones.json."""
    data = load_dataset(SYNTH)
    data.zones = [expected["crosswalk_zone"]]
    return data


@pytest.fixture
def data_copy(tmp_path, expected):
    dst = tmp_path / "synthetic"
    shutil.copytree(SYNTH, dst, ignore=shutil.ignore_patterns("agent_cache.json"))
    (dst / "zones.json").write_text(json.dumps([expected["crosswalk_zone"]]))
    return dst
