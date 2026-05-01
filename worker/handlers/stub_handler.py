"""Stub handler — fakes processing for v1 testing.

Sleeps for ~12s in 2-second increments, calling heartbeat_callback() between
each chunk so the stale-job sweeper sees the job as alive. Returns a fake
result so the admin UI can exercise the Complete tab.

In Session B this gets replaced by a real CV pipeline that:
  - Downloads the source file from Box
  - Runs OCR/jersey detection
  - Cuts clips around each detection
  - Uploads the clips to a new Box folder
  - Returns the real folder ID and clip count
"""

from __future__ import annotations

import time
from typing import Callable

from .base import Handler, HandlerResult
from ..lib import logger


class StubHandler(Handler):
    def process(self, request: dict, heartbeat_callback: Callable[[], None]) -> HandlerResult:
        request_id = request.get("id")
        jersey_number = request.get("jersey_number")
        jersey_color = request.get("jersey_color")
        box_file_id = request.get("box_file_id")

        logger.log_info(
            request_id,
            f"Stub: pretending to process request {request_id} for jersey #{jersey_number} {jersey_color}",
        )

        # Six 2-second chunks = 12s total, heartbeat between each.
        for chunk in range(6):
            time.sleep(2)
            heartbeat_callback()
            logger.log_info(
                request_id,
                f"Stub: heartbeat {chunk + 1}/6 (jersey #{jersey_number} {jersey_color})",
            )

        logger.log_info(
            request_id,
            f"Stub: would download box_file_id={box_file_id}",
        )
        logger.log_info(
            request_id,
            "Stub: would clean up source file (KEEP_SOURCE_ON_SUCCESS=false default)",
        )

        return HandlerResult(
            output_box_folder_id="STUB_FOLDER_12345",
            output_clip_count=0,
            output_metadata={
                "stub": True,
                "jersey_number": jersey_number,
                "jersey_color": jersey_color,
                "box_file_id": box_file_id,
            },
        )
