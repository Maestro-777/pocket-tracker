#!/usr/bin/env python3
"""Local, read-only Pocket Option chart bridge.

The browser talks only to 127.0.0.1. This process opens the broker WebSocket
using the session frame supplied by the user. Credentials are kept in memory
only and are never written to disk or printed to logs.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import ssl
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any

import certifi
import websockets
from websockets.exceptions import ConnectionClosed

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
HTTP_HOST = "127.0.0.1"
HTTP_PORT = 8000
WS_HOST = "127.0.0.1"
WS_PORT = 8765

DEMO_SERVERS = [
    "wss://demo-api-eu.po.market/socket.io/?EIO=4&transport=websocket",
    "wss://try-demo-eu.po.market/socket.io/?EIO=4&transport=websocket",
]
REAL_SERVERS = [
    "wss://api-eu.po.market/socket.io/?EIO=4&transport=websocket",
    "wss://api-eu2.po.market/socket.io/?EIO=4&transport=websocket",
    "wss://api-us-north.po.market/socket.io/?EIO=4&transport=websocket",
    "wss://api-us2.po.market/socket.io/?EIO=4&transport=websocket",
]
ALLOWED_PERIODS = {5, 15, 30, 60, 300, 900, 1800, 3600}
DEFAULT_ASSET = "EURUSD_otc"
# Pocket Option's history channel accepts an offset in bars. Keep each page
# large enough to reduce round trips, but small enough for a WebSocket frame.
HISTORY_PAGE_SIZE = 6000
AUTO_HISTORY_DAYS = 3
MAX_AUTO_HISTORY_PAGES = 20
HISTORY_PAGE_DELAY = 0.15

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("pocket-tracker")


def parse_auth_frame(raw: str) -> dict[str, Any]:
    """Parse the full 42["auth", {...}] frame copied from DevTools."""
    value = raw.strip()
    if value.startswith("42"):
        value = value[2:].strip()
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ValueError("Не удалось прочитать кадр. Нужен полный кадр 42[\"auth\", {...}].") from exc

    if isinstance(parsed, list) and len(parsed) >= 2 and parsed[0] == "auth":
        payload = parsed[1]
    elif isinstance(parsed, dict):
        payload = parsed
    else:
        raise ValueError("В кадре не найден объект авторизации Pocket Option.")

    if not isinstance(payload, dict):
        raise ValueError("Некорректные данные авторизации.")
    session = payload.get("session")
    uid = payload.get("uid")
    if not isinstance(session, str) or not session.strip():
        raise ValueError("В кадре отсутствует session.")
    try:
        uid = int(uid)
    except (TypeError, ValueError):
        raise ValueError("В кадре отсутствует корректный uid.")

    is_demo = 1 if str(payload.get("isDemo", 1)).lower() in {"1", "true"} else 0
    return {
        "session": session,
        "uid": uid,
        "isDemo": is_demo,
        "platform": int(payload.get("platform", 2) or 2),
        "isFastHistory": True,
        "isOptimized": True,
    }


def as_seconds(value: Any) -> int | None:
    try:
        number = float(value)
        if number > 10_000_000_000:
            number /= 1000
        if number <= 0:
            return None
        return int(number)
    except (TypeError, ValueError):
        return None


def normalize_candle(item: Any) -> dict[str, Any] | None:
    """Normalize known Pocket Option history shapes into Lightweight Charts OHLC."""
    try:
        volume = None
        if isinstance(item, dict):
            stamp = as_seconds(item.get("time", item.get("timestamp", item.get("at"))))
            opening = float(item.get("open"))
            closing = float(item.get("close"))
            high = float(item.get("high"))
            low = float(item.get("low"))
            raw_volume = item.get("volume")
            if raw_volume is not None:
                try:
                    volume = float(raw_volume)
                except (TypeError, ValueError):
                    volume = None
        elif isinstance(item, (list, tuple)) and len(item) >= 5:
            # Observed Pocket Option tuple: time, open, close, high, low[, volume].
            stamp = as_seconds(item[0])
            opening = float(item[1])
            closing = float(item[2])
            high = float(item[3])
            low = float(item[4])
            if len(item) > 5 and item[5] is not None:
                try:
                    volume = float(item[5])
                except (TypeError, ValueError):
                    volume = None
        else:
            return None
        if stamp is None:
            return None
        candle = {
            "time": stamp,
            "open": opening,
            "high": max(high, opening, closing),
            "low": min(low, opening, closing),
            "close": closing,
        }
        if volume is not None and volume >= 0:
            candle["volume"] = volume
        return candle
    except (TypeError, ValueError):
        return None


def collect_ticks(value: Any) -> list[tuple[str, int, float]]:
    found: list[tuple[str, int, float]] = []
    if isinstance(value, (list, tuple)):
        if (
            len(value) >= 3
            and isinstance(value[0], str)
            and isinstance(value[1], (int, float))
            and isinstance(value[2], (int, float))
        ):
            stamp = as_seconds(value[1])
            if stamp is not None:
                found.append((value[0], stamp, float(value[2])))
            return found
        for child in value:
            found.extend(collect_ticks(child))
    elif isinstance(value, dict):
        for child in value.values():
            found.extend(collect_ticks(child))
    return found


def ticks_to_candles(ticks: Any, period: int) -> list[dict[str, Any]]:
    """Convert historical [timestamp, price] ticks to OHLC bars."""
    grouped: dict[int, dict[str, Any]] = {}
    if not isinstance(ticks, list):
        return []
    for tick in ticks:
        try:
            if isinstance(tick, dict):
                stamp = as_seconds(tick.get("time", tick.get("timestamp")))
                price = float(tick.get("price", tick.get("close")))
            elif isinstance(tick, (list, tuple)) and len(tick) >= 2:
                stamp = as_seconds(tick[0])
                price = float(tick[1])
            else:
                continue
            if stamp is None:
                continue
            start = stamp // period * period
            bar = grouped.get(start)
            if bar is None:
                grouped[start] = {
                    "time": start, "open": price, "high": price,
                    "low": price, "close": price,
                }
            else:
                bar["high"] = max(bar["high"], price)
                bar["low"] = min(bar["low"], price)
                bar["close"] = price
        except (TypeError, ValueError):
            continue
    return [grouped[key] for key in sorted(grouped)]


class PocketBridge:
    def __init__(self, browser: Any):
        self.browser = browser
        self.broker: Any = None
        self.reader_task: asyncio.Task | None = None
        self.ping_task: asyncio.Task | None = None
        self.auth_payload: dict[str, Any] | None = None
        self.authenticated = False
        self.auth_event = asyncio.Event()
        self.auth_error: str | None = None
        self.asset = DEFAULT_ASSET
        self.period = 300
        self.latest_tick_time: int | None = None
        self.current_bar: dict[str, Any] | None = None
        self.history_requested = False
        self.history_cursor: int | None = None
        self.history_request_kind: str | None = None
        self.history_timeout_task: asyncio.Task | None = None
        self.history_reference_time: int | None = None
        self.history_candles: dict[int, dict[str, Any]] = {}
        self.history_auto_pages = 0
        self.history_auto_loading = False
        self.history_has_more = False
        self.history_target_time: int | None = None
        self.history_page_task: asyncio.Task | None = None
        self.closed = False

    async def send_browser(self, kind: str, **payload: Any) -> None:
        if self.closed:
            return
        try:
            await self.browser.send(json.dumps(
                {"type": kind, **payload}, ensure_ascii=False, separators=(",", ":")
            ))
        except Exception:
            self.closed = True

    async def status(self, message: str, state: str = "info") -> None:
        await self.send_browser("status", state=state, message=message)

    async def run(self) -> None:
        await self.status("Локальный мост готов. Вставь кадр авторизации Pocket Option.", "ready")
        try:
            async for raw in self.browser:
                try:
                    command = json.loads(raw)
                    await self.handle_command(command)
                except (json.JSONDecodeError, TypeError):
                    await self.status("Получена некорректная команда интерфейса.", "error")
        except ConnectionClosed:
            pass
        finally:
            self.closed = True
            await self.close_broker()

    async def handle_command(self, command: dict[str, Any]) -> None:
        action = command.get("action")
        if action == "connect":
            try:
                auth = parse_auth_frame(str(command.get("authFrame", "")))
                await self.connect_broker(auth)
            except Exception as exc:
                await self.status(str(exc), "error")
        elif action == "subscribe":
            asset = str(command.get("asset", DEFAULT_ASSET)).strip()
            period = int(command.get("period", 300))
            if not re.fullmatch(r"[A-Za-z0-9_#]{3,32}", asset):
                await self.status("Некорректный код инструмента.", "error")
                return
            if period not in ALLOWED_PERIODS:
                await self.status("Этот таймфрейм пока не поддерживается мостом.", "error")
                return
            self.asset = asset
            self.period = period
            self.current_bar = None
            self.latest_tick_time = None
            await self.reset_history()
            if self.authenticated:
                await self.subscribe_broker()
        elif action == "loadMore":
            if not self.authenticated or self.broker is None:
                await self.status("Сначала подключись к Pocket Option.", "warning")
                return
            if self.history_cursor is None:
                await self.status("Сначала дождись загрузки истории.", "warning")
                return
            if self.history_target_time is not None and self.history_cursor <= self.history_target_time:
                await self.status("Загружены все доступные свечи за последние 3 дня.", "info")
                return
            if self.history_request_kind is not None or self.history_auto_loading:
                return
            await self.request_history("older")
        elif action == "disconnect":
            await self.close_broker()
            await self.status("Подключение закрыто.", "ready")

    async def connect_broker(self, auth: dict[str, Any]) -> None:
        await self.close_broker()
        self.auth_payload = auth
        self.authenticated = False
        self.auth_error = None
        self.auth_event = asyncio.Event()
        servers = DEMO_SERVERS if auth["isDemo"] else REAL_SERVERS
        await self.status(
            "Подключаюсь к Pocket Option (" + ("DEMO" if auth["isDemo"] else "REAL") + ")…",
            "connecting",
        )

        last_error = "Не удалось подключиться."
        # Keep hostname and certificate verification enabled. Merge the OS trust
        # store with certifi's maintained Mozilla CA bundle; this helps Python
        # installations whose CA bundle is missing or outdated without disabling TLS.
        tls_context = ssl.create_default_context()
        tls_context.load_verify_locations(cafile=certifi.where())

        for url in servers:
            try:
                # The broker's WebSocket handshake is origin-sensitive. This local
                # bridge sets the platform origin; the browser never handles SSID.
                self.broker = await websockets.connect(
                    url,
                    origin="https://pocketoption.com",
                    ssl=tls_context,
                    ping_interval=None,
                    close_timeout=5,
                    open_timeout=10,
                    max_size=2_000_000,
                )
                self.reader_task = asyncio.create_task(self.read_broker())
                self.ping_task = asyncio.create_task(self.ping_broker())
                try:
                    await asyncio.wait_for(self.auth_event.wait(), timeout=18)
                except asyncio.TimeoutError:
                    last_error = "Сервер не подтвердил авторизацию за отведённое время."
                if self.authenticated:
                    await self.status(
                        "Соединение установлено. Загружаю " + self.asset + "…",
                        "connected",
                    )
                    await self.subscribe_broker()
                    return
                if self.auth_error:
                    last_error = self.auth_error
                await self.close_broker()
            except ssl.SSLCertVerificationError as exc:
                host = url.split("/")[2]
                last_error = (
                    f"Проверка TLS-сертификата {host} не прошла: "
                    f"{exc.verify_message} (код {exc.verify_code})."
                )
                log.warning("TLS certificate validation failed for %s: %s", host, exc.verify_message)
                await self.close_broker()
            except Exception as exc:
                host = url.split("/")[2]
                last_error = f"Не удалось открыть WebSocket {host} ({type(exc).__name__}: {exc})."
                log.warning("WebSocket connection failed for %s: %s", host, exc)
                await self.close_broker()

        await self.status(
            last_error + " Проверь сессию и доступность серверов Pocket Option.",
            "error",
        )

    async def reset_history(self) -> None:
        await self.cancel_history_request()
        page_task = self.history_page_task
        self.history_page_task = None
        if page_task and page_task is not asyncio.current_task():
            page_task.cancel()
            try:
                await page_task
            except (asyncio.CancelledError, Exception):
                pass
        self.history_cursor = None
        self.history_reference_time = None
        self.history_target_time = None
        self.history_candles.clear()
        self.history_auto_pages = 0
        self.history_auto_loading = False
        self.history_has_more = False

    async def close_broker(self) -> None:
        self.authenticated = False
        self.history_auto_loading = False
        await self.cancel_history_request()
        page_task = self.history_page_task
        self.history_page_task = None
        if page_task and page_task is not asyncio.current_task():
            page_task.cancel()
            try:
                await page_task
            except (asyncio.CancelledError, Exception):
                pass
        if self.ping_task and self.ping_task is not asyncio.current_task():
            self.ping_task.cancel()
            try:
                await self.ping_task
            except (asyncio.CancelledError, Exception):
                pass
        self.ping_task = None
        if self.reader_task and self.reader_task is not asyncio.current_task():
            self.reader_task.cancel()
            try:
                await self.reader_task
            except (asyncio.CancelledError, Exception):
                pass
        self.reader_task = None
        if self.broker is not None:
            try:
                await self.broker.close()
            except Exception:
                pass
        self.broker = None

    async def ping_broker(self) -> None:
        while self.broker is not None:
            await asyncio.sleep(20)
            if self.broker is None:
                return
            try:
                await self.broker.send('42["ps"]')
            except Exception:
                return

    async def send_broker_event(self, event: str, data: Any = None) -> None:
        if self.broker is None:
            return
        if data is None:
            frame = "42" + json.dumps([event], separators=(",", ":"))
        else:
            frame = "42" + json.dumps([event, data], separators=(",", ":"))
        await self.broker.send(frame)

    async def read_broker(self) -> None:
        try:
            async for message in self.broker:
                if isinstance(message, bytes):
                    continue
                if message.startswith('0{"sid":'):
                    await self.broker.send("40")
                elif message.startswith('40{"sid":'):
                    await self.send_broker_event("auth", self.auth_payload)
                elif message == "2":
                    await self.broker.send("3")
                elif message == "41":
                    self.auth_error = "Pocket Option отклонил сессию (namespace disconnect)."
                    self.auth_event.set()
                    await self.status(self.auth_error, "error")
                    return
                elif message.startswith("451-"):
                    try:
                        event_data = json.loads(message.split("-", 1)[1])
                        event_name = event_data[0]
                        binary_payload = await asyncio.wait_for(self.broker.recv(), timeout=6)
                        if isinstance(binary_payload, bytes):
                            payload = json.loads(binary_payload.decode("utf-8"))
                            await self.handle_broker_event(event_name, payload)
                    except Exception as exc:
                        log.debug("Binary event could not be decoded: %s", type(exc).__name__)
                elif message.startswith("42") and "NotAuthorized" in message:
                    self.auth_error = "Pocket Option отклонил авторизацию. Сессия недействительна или истекла."
                    self.auth_event.set()
                    await self.status(self.auth_error, "error")
                    return
                elif message.startswith("42"):
                    try:
                        event_data = json.loads(message[2:])
                        if isinstance(event_data, list) and event_data:
                            await self.handle_broker_event(
                                str(event_data[0]),
                                event_data[1] if len(event_data) > 1 else None,
                            )
                    except Exception:
                        pass
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if not self.closed:
                await self.status(
                    "Соединение с Pocket Option прервано (" + type(exc).__name__ + ").",
                    "error",
                )
        finally:
            if not self.authenticated:
                self.auth_event.set()
            elif not self.closed:
                self.authenticated = False
                await self.status("Соединение с Pocket Option закрыто сервером.", "error")

    async def cancel_history_request(self) -> None:
        self.history_request_kind = None
        task = self.history_timeout_task
        self.history_timeout_task = None
        if task and task is not asyncio.current_task():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    async def history_request_timeout(self, kind: str) -> None:
        try:
            await asyncio.sleep(20)
            if self.history_request_kind == kind:
                self.history_request_kind = None
                self.history_timeout_task = None
                await self.send_browser("historyLoading", loading=False, request_kind=kind)
                if kind == "bulk":
                    await self.finish_auto_history("timeout", has_more=False)
                else:
                    await self.status("Сервер не прислал запрошенную историю. Попробуй ещё раз.", "warning")
        except asyncio.CancelledError:
            raise

    async def request_history(self, kind: str, before_time: int | None = None) -> None:
        if not self.authenticated or self.broker is None:
            return
        if self.history_request_kind is not None:
            return
        if kind in {"older", "bulk"}:
            if before_time is None:
                before_time = self.history_cursor
            if before_time is None:
                return
            end_time = max(1, int(before_time) - self.period)
        else:
            # Anchor to the selected instrument's latest tick only.
            end_time = self.latest_tick_time or int(time.time())
            self.history_reference_time = end_time
            self.history_target_time = end_time - AUTO_HISTORY_DAYS * 86400

        target = self.history_target_time or (end_time - AUTO_HISTORY_DAYS * 86400)
        remaining_bars = max(1, int((end_time - target) / self.period) + 2)
        page_size = min(HISTORY_PAGE_SIZE, remaining_bars)

        self.history_request_kind = kind
        await self.send_browser("historyLoading", loading=True, request_kind=kind)
        await self.send_broker_event("loadHistoryPeriod", {
            "asset": self.asset,
            "index": int(time.time() * 1000),
            "offset": page_size,
            "period": self.period,
            "time": end_time,
        })
        self.history_timeout_task = asyncio.create_task(self.history_request_timeout(kind))
        if kind == "older":
            await self.status(f"Запрашиваю более старые свечи {self.asset} · {self.period}s…", "connected")
        elif kind == "bulk":
            await self.status(f"Догружаю историю {self.asset} · {self.period}s за последние 3 дня…", "connected")
        else:
            self.history_requested = True
            await self.status(
                f"Запрашиваю историю {self.asset} · {self.period}s за последние 3 дня (порциями).",
                "connected",
            )

    async def start_auto_history(self, first_page: list[dict[str, Any]]) -> None:
        target = self.history_target_time or ((self.history_reference_time or int(time.time())) - AUTO_HISTORY_DAYS * 86400)
        self.history_candles = {
            int(bar["time"]): bar for bar in first_page if int(bar["time"]) >= target
        }
        self.history_cursor = min(self.history_candles) if self.history_candles else None
        self.history_auto_pages = 1
        self.history_auto_loading = True
        self.history_has_more = False
        await self.send_browser(
            "history", asset=self.asset, period=self.period,
            candles=list(self.history_candles.values()), has_more=False,
        )
        if self.history_cursor is None:
            await self.finish_auto_history("empty", has_more=False)
            return
        if self.history_cursor <= target:
            await self.finish_auto_history("target", has_more=False)
            return
        self.history_page_task = asyncio.create_task(self.request_next_history_page())

    async def request_next_history_page(self) -> None:
        try:
            await asyncio.sleep(HISTORY_PAGE_DELAY)
            if self.history_auto_loading and self.authenticated and self.broker is not None:
                await self.request_history("bulk")
        except asyncio.CancelledError:
            raise
        finally:
            if self.history_page_task is asyncio.current_task():
                self.history_page_task = None

    async def finish_auto_history(self, reason: str, has_more: bool) -> None:
        self.history_auto_loading = False
        task = self.history_page_task
        self.history_page_task = None
        if task and task is not asyncio.current_task():
            task.cancel()
        self.history_has_more = has_more
        rows = [self.history_candles[key] for key in sorted(self.history_candles)]
        oldest = rows[0]["time"] if rows else None
        reference = self.history_reference_time or int(time.time())
        days = max(0.0, (reference - oldest) / 86400) if oldest is not None else 0.0
        await self.send_browser(
            "historyComplete", asset=self.asset, period=self.period,
            candles=rows, has_more=has_more, days_covered=round(days, 2),
            page_count=self.history_auto_pages, reason=reason,
        )
        await self.send_browser("historyLoading", loading=False, request_kind="bulk")
        if reason == "target":
            message = f"Загружены последние 3 дня для {self.asset} · {self.period}s: {len(rows)} свечей ({days:.1f} дней)."
        elif reason == "max_pages":
            message = f"Загрузка остановлена по защитному лимиту: {len(rows)} свечей, {days:.1f} дней."
        elif reason == "timeout":
            message = f"История загружена частично: {len(rows)} свечей, {days:.1f} дней. Live-поток продолжает работать."
        elif reason == "empty":
            message = "Сервер не вернул исторические свечи."
        else:
            message = f"Доступная история закончилась: {len(rows)} свечей, примерно {days:.1f} дней."
        await self.status(message, "connected" if rows else "warning")

    async def handle_broker_event(self, name: str, data: Any) -> None:
        if name == "successauth":
            self.authenticated = True
            self.auth_event.set()
            await self.send_broker_event("indicator/load")
            await self.send_broker_event("favorite/load")
            await self.send_broker_event("price-alert/load")
            await self.status("Авторизация подтверждена. Подписываюсь на котировки…", "connected")
        elif name == "loadHistoryPeriodFast":
            kind = self.history_request_kind
            if kind is None:
                log.debug("Ignoring unsolicited history response")
                return
            await self.cancel_history_request()
            raw_bars = data.get("data", []) if isinstance(data, dict) else []
            bars = [bar for item in raw_bars if (bar := normalize_candle(item)) is not None]
            if not bars and raw_bars:
                bars = ticks_to_candles(raw_bars, self.period)
            if not bars:
                if kind == "bulk":
                    await self.finish_auto_history("end", has_more=False)
                else:
                    await self.send_browser("historyLoading", loading=False, request_kind=kind)
                    await self.send_browser("historyEnd")
                    await self.status("Исторические свечи больше не найдены.", "warning")
                return

            bars.sort(key=lambda bar: bar["time"])
            deduped = {int(bar["time"]): bar for bar in bars}
            clean = [deduped[key] for key in sorted(deduped)]
            previous_cursor = self.history_cursor
            new_cursor = min(bar["time"] for bar in clean)

            if kind == "initial":
                target = (self.history_reference_time or int(time.time())) - AUTO_HISTORY_DAYS * 86400
                clean = [bar for bar in clean if bar["time"] >= target]
                await self.start_auto_history(clean)
                return

            if kind == "bulk":
                if previous_cursor is None or new_cursor >= previous_cursor:
                    await self.finish_auto_history("end", has_more=False)
                    return
                target = (self.history_reference_time or int(time.time())) - AUTO_HISTORY_DAYS * 86400
                for bar in clean:
                    if bar["time"] >= target:
                        self.history_candles[int(bar["time"])] = bar
                self.history_cursor = new_cursor
                self.history_auto_pages += 1
                rows_count = len(self.history_candles)
                days = max(0.0, ((self.history_reference_time or int(time.time())) - new_cursor) / 86400)
                await self.send_browser(
                    "historyProgress", candles_count=rows_count,
                    days_covered=round(days, 2), pages=self.history_auto_pages,
                )
                if new_cursor <= target:
                    await self.finish_auto_history("target", has_more=False)
                elif self.history_auto_pages >= MAX_AUTO_HISTORY_PAGES:
                    await self.finish_auto_history("max_pages", has_more=False)
                else:
                    self.history_page_task = asyncio.create_task(self.request_next_history_page())
                return

            # User-requested one-page extension after the automatic month load.
            if previous_cursor is None or new_cursor >= previous_cursor:
                await self.send_browser("historyLoading", loading=False, request_kind="older")
                await self.send_browser("historyEnd")
                self.history_has_more = False
                await self.status("Более ранняя история не найдена.", "warning")
                return
            for bar in clean:
                self.history_candles[int(bar["time"])] = bar
            self.history_cursor = new_cursor
            await self.send_browser(
                "historyOlder", asset=self.asset, period=self.period,
                candles=clean, has_more=True,
            )
            await self.send_browser("historyLoading", loading=False, request_kind="older")
            await self.status(f"Добавлено ещё {len(clean)} свечей истории.", "connected")
        elif name == "updateStream":
            for asset, stamp, price in collect_ticks(data):
                await self.handle_tick(asset, stamp, price)
        elif name == "updateAssets" and isinstance(data, list):
            symbols = []
            for row in data:
                if isinstance(row, list) and len(row) > 1 and isinstance(row[1], str):
                    available = row[14] if len(row) > 14 else True
                    if available:
                        symbols.append(row[1])
            if symbols:
                await self.send_browser("assets", symbols=sorted(set(symbols)))

    async def subscribe_broker(self) -> None:
        if not self.authenticated or self.broker is None:
            return
        await self.reset_history()
        await self.send_broker_event(
            "changeSymbol", {"asset": self.asset, "period": self.period}
        )
        await self.send_broker_event("subfor", self.asset)
        await self.request_history("initial")

    async def handle_tick(self, asset: str, stamp: int, price: float) -> None:
        if asset != self.asset:
            return
        self.latest_tick_time = stamp
        start = stamp // self.period * self.period
        if self.current_bar is None or start > self.current_bar["time"]:
            self.current_bar = {
                "time": start, "open": price, "high": price,
                "low": price, "close": price,
            }
        elif start == self.current_bar["time"]:
            self.current_bar["high"] = max(self.current_bar["high"], price)
            self.current_bar["low"] = min(self.current_bar["low"], price)
            self.current_bar["close"] = price
        else:
            return
        await self.send_browser(
            "candle", candle=self.current_bar, asset=self.asset, price=price
        )


async def websocket_handler(browser: Any, path: str | None = None) -> None:
    bridge = PocketBridge(browser)
    await bridge.run()


def start_http_server() -> ThreadingHTTPServer:
    handler = lambda *args, **kwargs: SimpleHTTPRequestHandler(
        *args, directory=str(WEB_DIR), **kwargs
    )
    server = ThreadingHTTPServer((HTTP_HOST, HTTP_PORT), handler)
    thread = Thread(target=server.serve_forever, name="pocket-tracker-http", daemon=True)
    thread.start()
    return server


async def main() -> None:
    if not WEB_DIR.exists():
        raise RuntimeError("Не найдена папка web/. Запускай bridge.py из корня проекта.")
    http_server = start_http_server()
    log.info("Интерфейс: http://%s:%s", HTTP_HOST, HTTP_PORT)
    log.info("Локальный WebSocket мост: ws://%s:%s", WS_HOST, WS_PORT)
    log.info("Мост принимает подключения только с этого компьютера.")
    try:
        async with websockets.serve(
            websocket_handler, WS_HOST, WS_PORT, max_size=2_000_000,
            origins=["http://127.0.0.1:8000", "http://localhost:8000"],
        ):
            await asyncio.Future()
    finally:
        http_server.shutdown()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nPocket Tracker остановлен.")
