"""Deterministic closed-candle signal engine for Pocket Tracker."""
from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any


class ClosedCandleStrategy:
    """BB(20, 2) + Wilder RSI(14), evaluated only on completed 5s candles."""

    def __init__(
        self,
        *,
        period: int = 5,
        bb_period: int = 20,
        bb_multiplier: float = 2.0,
        rsi_period: int = 14,
        put_rsi: tuple[float, float] = (77.0, 83.0),
        call_rsi: tuple[float, float] = (18.0, 23.0),
        bb_source: str = "close",
        rsi_source: str = "close",
    ) -> None:
        self.period = period
        self.bb_period = bb_period
        self.bb_multiplier = bb_multiplier
        self.rsi_period = rsi_period
        self.put_rsi = put_rsi
        self.call_rsi = call_rsi
        self.bb_source = bb_source
        self.rsi_source = rsi_source

    @staticmethod
    def point_size(asset: str, digits: int | None = None) -> float:
        if digits is not None and 0 <= digits <= 12:
            return 10.0 ** -digits
        if "BTC" in asset.upper():
            return 0.01
        if "JPY" in asset.upper():
            return 0.001
        return 0.00001

    def evaluate(
        self,
        candles: Sequence[dict[str, Any]],
        *,
        asset: str,
        digits: int | None = None,
    ) -> dict[str, Any] | None:
        rows = sorted(
            (row for row in candles if self._valid_candle(row)),
            key=lambda row: int(row["time"]),
        )
        required = max(self.bb_period, self.rsi_period + 1)
        if len(rows) < required:
            return None

        closes = [float(row["close"]) for row in rows]
        bb_values = [self._source(row, self.bb_source) for row in rows[-self.bb_period:]]
        rsi_values = [self._source(row, self.rsi_source) for row in rows]
        if any(not math.isfinite(value) for value in bb_values + rsi_values):
            return None
        middle = sum(bb_values) / self.bb_period
        variance = sum((value - middle) ** 2 for value in bb_values) / self.bb_period
        deviation = math.sqrt(max(0.0, variance))
        upper = middle + self.bb_multiplier * deviation
        lower = middle - self.bb_multiplier * deviation
        rsi = self._wilder_rsi(rsi_values, self.rsi_period)
        close = closes[-1]
        point = self.point_size(asset, digits)

        direction = None
        distance_points = None
        if close >= upper and close - upper <= point and self.put_rsi[0] <= rsi <= self.put_rsi[1]:
            direction = "PUT"
            distance_points = (close - upper) / point
        elif close <= lower and lower - close <= point and self.call_rsi[0] <= rsi <= self.call_rsi[1]:
            direction = "CALL"
            distance_points = (lower - close) / point

        if direction is None:
            return None

        candle_time = int(rows[-1]["time"])
        return {
            "id": f"{asset}:{self.period}:{candle_time}:{direction}",
            "asset": asset,
            "period": self.period,
            "candleTime": candle_time,
            "direction": direction,
            "durationSeconds": 15,
            "entryPrice": close,
            "bollingerUpper": upper,
            "bollingerLower": lower,
            "rsi": rsi,
            "distancePoints": distance_points,
            "createdAt": candle_time * 1000,
        }

    @staticmethod
    def _source(row: dict[str, Any], source: str) -> float:
        if source == "open":
            return float(row["open"])
        if source == "hl2":
            return (float(row["high"]) + float(row["low"])) / 2
        if source == "hlc3":
            return (float(row["high"]) + float(row["low"]) + float(row["close"])) / 3
        if source == "ohlc4":
            return (float(row["open"]) + float(row["high"]) + float(row["low"]) + float(row["close"])) / 4
        return float(row["close"])

    @staticmethod
    def _valid_candle(row: dict[str, Any]) -> bool:
        try:
            values = [float(row[key]) for key in ("open", "high", "low", "close")]
            stamp = int(row["time"])
            return stamp > 0 and all(math.isfinite(value) and value > 0 for value in values)
        except (KeyError, TypeError, ValueError, OverflowError):
            return False

    @staticmethod
    def _wilder_rsi(closes: list[float], period: int) -> float:
        changes = [closes[index] - closes[index - 1] for index in range(1, len(closes))]
        gains = [max(change, 0.0) for change in changes]
        losses = [max(-change, 0.0) for change in changes]
        avg_gain = sum(gains[:period]) / period
        avg_loss = sum(losses[:period]) / period
        for index in range(period, len(gains)):
            avg_gain = (avg_gain * (period - 1) + gains[index]) / period
            avg_loss = (avg_loss * (period - 1) + losses[index]) / period
        if avg_loss == 0:
            return 50.0 if avg_gain == 0 else 100.0
        return 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
