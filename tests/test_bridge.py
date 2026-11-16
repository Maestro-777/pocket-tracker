import asyncio
import unittest

from bridge import PocketBridge, collect_ticks, extract_history_rows, ticks_to_candles


class FakeBrowser:
    def __init__(self):
        self.messages = []

    async def send(self, message):
        self.messages.append(message)


class BridgeDataTests(unittest.TestCase):
    def test_collect_flat_ticks(self):
        self.assertEqual(
            collect_ticks(["EURUSD_otc", 1_700_000_000, 1.0832]),
            [("EURUSD_otc", 1_700_000_000, 1.0832)],
        )

    def test_collect_nested_asset_ticks(self):
        payload = ["EURUSD_otc", [[1_700_000_000, 1.0832], [1_700_000_001, 1.0834]]]
        self.assertEqual(
            collect_ticks(payload),
            [("EURUSD_otc", 1_700_000_000, 1.0832), ("EURUSD_otc", 1_700_000_001, 1.0834)],
        )

    def test_collect_asset_keyed_ticks(self):
        self.assertEqual(
            collect_ticks({"EURUSD_otc": [[1_700_000_000, 1.0832]]}),
            [("EURUSD_otc", 1_700_000_000, 1.0832)],
        )

    def test_extract_history_container(self):
        rows = [[1_700_000_000, 1.0, 1.2, 1.3, 0.9]]
        self.assertEqual(extract_history_rows({"result": {"data": rows}}), rows)

    def test_ticks_to_candles_aggregates_ohlc(self):
        bars = ticks_to_candles(
            [[1_700_000_000, 1.0], [1_700_000_002, 1.4], [1_700_000_006, 1.2]],
            5,
        )
        self.assertEqual(len(bars), 2)
        self.assertEqual(
            (bars[0]["open"], bars[0]["high"], bars[0]["low"], bars[0]["close"]),
            (1.0, 1.4, 1.0, 1.4),
        )

    def test_live_tick_merges_into_historical_candle(self):
        browser = FakeBrowser()
        bridge = PocketBridge(browser)
        bridge.asset = "EURUSD_otc"
        bridge.period = 5
        bridge.history_candles[1_700_000_000] = {
            "time": 1_700_000_000, "open": 1.0, "high": 1.2, "low": 0.9, "close": 1.1
        }
        bridge.last_live_emit = 0
        asyncio.run(bridge.handle_tick("EURUSD_otc", 1_700_000_002, 1.3))
        bar = bridge.current_bar
        self.assertEqual(bar["time"], 1_700_000_000)
        self.assertEqual(bar["open"], 1.0)
        self.assertEqual(bar["high"], 1.3)
        self.assertEqual(bar["low"], 0.9)
        self.assertEqual(bar["close"], 1.3)

    def test_other_asset_and_invalid_ticks_are_ignored(self):
        bridge = PocketBridge(FakeBrowser())
        bridge.asset = "EURUSD_otc"
        asyncio.run(bridge.handle_tick("GBPUSD_otc", 1_700_000_000, 1.2))
        asyncio.run(bridge.handle_tick("EURUSD_otc", 1_700_000_000, float("nan")))
        self.assertIsNone(bridge.current_bar)


if __name__ == "__main__":
    unittest.main()
