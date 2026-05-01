"""Handler interface — every concrete handler implements this."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Callable, TypedDict


class HandlerResult(TypedDict):
    output_box_folder_id: str
    output_clip_count: int
    output_metadata: dict


class Handler(ABC):
    @abstractmethod
    def process(self, request: dict, heartbeat_callback: Callable[[], None]) -> HandlerResult:
        """Process a request.

        `request` is the dict returned by claim_next_highlight_job (the full
        highlight_requests row).

        `heartbeat_callback` should be invoked periodically during long work so
        the stale-job sweeper does not reset this job. The caller is responsible
        for setting up a separate heartbeat thread for fixed cadence; this
        callback is for explicit checkpoint pings inside the handler.
        """
        ...
