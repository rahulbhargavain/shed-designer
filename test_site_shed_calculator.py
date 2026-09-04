"""Smoke tests for site_shed_calculator.run_calculation.

Exercises each supported tube_size/gauge combination and confirms the
report runs to completion without raising, for both the default
dimensions and a range of alternate shed sizes.
"""
import math

import pytest

from site_shed_calculator import run_calculation

TUBE_VARIANTS = [
    ("1.5", 12), ("1.5", 16), ("1.5", 14),
    ("2.0", 12), ("2.0", 16), ("2.0", 14),
    ("1.5_rect", 12), ("1.5_rect", 16), ("1.5_rect", 14),
]


def test_default_parameters_run_cleanly(capsys):
    run_calculation()
    out = capsys.readouterr().out
    assert "AERO-SHED TWIN-MODULE PORTABLE MATING TUNNEL REPORT" in out
    assert "STRUCTURAL ENGINEERING SAFETY ASSESSMENT" in out


@pytest.mark.parametrize("tube_size,tube_gauge", TUBE_VARIANTS)
def test_all_tube_variants_run_cleanly(tube_size, tube_gauge, capsys):
    run_calculation(tube_size=tube_size, tube_gauge=tube_gauge)
    out = capsys.readouterr().out
    assert "Total Frame Steel Weight" in out


@pytest.mark.parametrize("length,width,height,rise", [
    (9.8, 11.0, 8.0, 2.5),
    (20.0, 10.0, 8.0, 2.0),
    (12.0, 12.0, 9.0, 3.0),
])
def test_alternate_dimensions_produce_finite_results(length, width, height, rise, capsys):
    run_calculation(length=length, width=width, height=height, rise=rise)
    out = capsys.readouterr().out
    assert "nan" not in out.lower()
    assert "inf" not in out.lower()
