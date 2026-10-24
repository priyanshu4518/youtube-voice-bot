"""In-memory LRU cache and single-flight request coalescing.

Both are used only from the event loop thread, so they need no locks.
"""
import asyncio
from collections import OrderedDict
from typing import Any, Awaitable, Callable, Hashable


class LRUCache:
    """Evicts least recently used entries once `max_items` or `max_weight` is exceeded.
    `weigh` gives each value's weight (e.g. its size in bytes); by default every entry weighs 1."""

    def __init__(self, max_items: int = 0, max_weight: float = 0, weigh: Callable[[Any], float] = lambda v: 1):
        self._data: OrderedDict[Hashable, Any] = OrderedDict()
        self._max_items, self._max_weight, self._weigh = max_items, max_weight, weigh
        self._weight = 0.0

    def get(self, key: Hashable) -> Any | None:
        if key not in self._data:
            return None
        self._data.move_to_end(key)
        return self._data[key]

    def put(self, key: Hashable, value: Any) -> None:
        if key in self._data:
            self._weight -= self._weigh(self._data.pop(key))
        self._data[key] = value
        self._weight += self._weigh(value)
        while self._data and (
            (self._max_items and len(self._data) > self._max_items)
            or (self._max_weight and self._weight > self._max_weight)
        ):
            _, old = self._data.popitem(last=False)
            self._weight -= self._weigh(old)

    def __len__(self) -> int:
        return len(self._data)


class SingleFlight:
    """Concurrent callers asking for the same key share one in-flight computation.

    The popup calls /transcript as soon as it opens, and the user may ask right away, so two
    requests often index the same video at once. Without this, both would download the
    transcript and embed it."""

    def __init__(self):
        self._inflight: dict[Hashable, asyncio.Future] = {}

    async def do(self, key: Hashable, fn: Callable[[], Awaitable[Any]]) -> Any:
        fut = self._inflight.get(key)
        if fut is None:
            fut = asyncio.ensure_future(fn())
            self._inflight[key] = fut
            fut.add_done_callback(lambda f: self._finish(key, f))
        # shield: a caller that disconnects must not cancel work other callers are waiting on.
        return await asyncio.shield(fut)

    def _finish(self, key: Hashable, fut: asyncio.Future) -> None:
        self._inflight.pop(key, None)
        if not fut.cancelled():
            fut.exception()  # mark as retrieved so an unawaited failure isn't logged as a warning
