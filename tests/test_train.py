"""Training, in-process, on a sample of the real feature table.

The integration test runs `python -m dfsi.forecaster.train` end to end; this
runs `train()` itself on 3% of the scenarios, with every output redirected
to a temp directory, so the training code is exercised by the ordinary unit
suite wherever the Memory layer has been built (locally and in CI).
"""

from __future__ import annotations

import json

import pandas as pd
import pytest
from conftest import requires_memory

from dfsi.config import PATHS, Paths
from dfsi.forecaster import train as train_module
from dfsi.forecaster.train import (
    FEATURE_COLUMNS,
    GROUP_COLUMN,
    WEEK_COLUMN,
    TrainConfig,
    assert_no_leakage,
    split_by_scenario,
    split_by_time,
)


@pytest.fixture(scope="module")
def sample() -> pd.DataFrame:
    frame = pd.read_parquet(PATHS.features)
    keep = frame[GROUP_COLUMN].drop_duplicates().sample(frac=0.03, random_state=3)
    return frame[frame[GROUP_COLUMN].isin(keep)].reset_index(drop=True)


@pytest.fixture
def isolated(tmp_path, monkeypatch, sample):
    """`train()` reads `sample` and writes only under `tmp_path`."""
    monkeypatch.setattr(train_module, "PATHS", Paths(home=tmp_path))
    monkeypatch.setattr(train_module, "MLFLOW_TRACKING_URI", (tmp_path / "mlruns").as_uri())
    monkeypatch.setattr(train_module, "load_features", lambda: sample.copy())
    return tmp_path


@requires_memory
@pytest.mark.parametrize("split", ["scenario", "time"])
def test_train_writes_a_model_and_a_report_without_leakage(isolated, split):
    report = train_module.train(TrainConfig(split=split, max_iter=40))
    written = json.loads((isolated / "models" / "training_report.json").read_text())
    assert (isolated / "models" / "forecaster.pkl").exists()
    assert written["decision_threshold"] == report["decision_threshold"]
    assert 0.0 < report["decision_threshold"] < 1.0
    assert set(report["features"]) <= set(FEATURE_COLUMNS)
    assert {"scenario_id", "scenario_type"}.isdisjoint(report["features"])
    # The incumbent warns at the bell by construction: its head start is zero.
    assert report["fixed_threshold_baseline"]["median_lead_seconds"] in (0, 0.0, None)


@requires_memory
def test_an_unknown_split_is_refused(isolated):
    with pytest.raises(ValueError, match="unknown split"):
        train_module.train(TrainConfig(split="random-rows"))


@requires_memory
def test_splits_never_share_a_scenario(sample):
    dev, test = split_by_scenario(sample, test_size=0.3, random_state=0)
    assert set(dev[GROUP_COLUMN]).isdisjoint(test[GROUP_COLUMN])

    fit, calib, held_out = split_by_time(sample, test_weeks=1, calibration_weeks=1)
    weeks = [set(part[WEEK_COLUMN]) for part in (fit, calib, held_out)]
    assert max(weeks[0]) < min(weeks[1]) < min(weeks[2])  # the future is never fitted on


def test_split_by_time_needs_week_indices():
    with pytest.raises(ValueError, match="week_index"):
        split_by_time(pd.DataFrame({GROUP_COLUMN: ["a"]}), test_weeks=1, calibration_weeks=1)


def test_a_forbidden_feature_is_refused():
    with pytest.raises(ValueError, match="scenario_id"):
        assert_no_leakage([*FEATURE_COLUMNS, "scenario_id"])


def test_a_missing_feature_table_says_how_to_build_it(tmp_path, monkeypatch):
    monkeypatch.setattr(train_module, "PATHS", Paths(home=tmp_path))
    with pytest.raises(FileNotFoundError, match=r"dfsi\.memory\.pipeline"):
        train_module.load_features()
