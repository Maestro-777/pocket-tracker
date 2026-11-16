import unittest

from strategy import ClosedCandleStrategy


class ClosedCandleStrategyTests(unittest.TestCase):
    def setUp(self):
        self.strategy = ClosedCandleStrategy()

    def test_requires_enough_closed_candles(self):
        rows = [
            {"time": 1_700_000_000 + index * 5, "open": 1.1, "high": 1.1, "low": 1.1, "close": 1.1}
            for index in range(20)
        ]
        self.assertIsNone(self.strategy.evaluate(rows, asset="EURUSD_otc"))

    def test_point_size_uses_asset_precision(self):
        self.assertEqual(self.strategy.point_size("EURUSD_otc", 5), 0.00001)
        self.assertEqual(self.strategy.point_size("USDJPY_otc", 3), 0.001)
        self.assertEqual(self.strategy.point_size("BTCUSD_otc", 2), 0.01)

    def test_rejects_invalid_candles(self):
        rows = [
            {"time": index + 1, "open": 1, "high": 1, "low": 1, "close": 1}
            for index in range(34)
        ]
        rows[-1]["close"] = float("nan")
        self.assertIsNone(self.strategy.evaluate(rows, asset="EURUSD_otc"))


if __name__ == "__main__":
    unittest.main()
