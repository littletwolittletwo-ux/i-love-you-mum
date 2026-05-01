"""Collects full conversation transcript during a call and fires callback on end."""

import asyncio

from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.frames.frames import (
    TranscriptionFrame,
    LLMTextFrame,
    LLMFullResponseEndFrame,
    EndFrame,
    Frame,
)


class TranscriptCollector(FrameProcessor):
    """Watches frames flowing through the pipeline and builds a transcript.

    - TranscriptionFrame -> user utterance
    - LLMTextFrame -> assistant token (accumulated until LLMFullResponseEndFrame)
    - EndFrame -> call ended, fire callback with full transcript
    """

    def __init__(self, on_call_end=None, **kwargs):
        super().__init__(**kwargs)
        self._transcript: list[dict] = []
        self._current_assistant_chunks: list[str] = []
        self._on_call_end = on_call_end

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame):
            text = frame.text.strip()
            if text:
                # Flush any pending assistant response first
                self._flush_assistant_turn()
                self._transcript.append({"role": "user", "content": text})

        elif isinstance(frame, LLMTextFrame):
            self._current_assistant_chunks.append(frame.text)

        elif isinstance(frame, LLMFullResponseEndFrame):
            self._flush_assistant_turn()

        elif isinstance(frame, EndFrame):
            self._flush_assistant_turn()
            if self._on_call_end and self._transcript:
                asyncio.create_task(self._on_call_end(list(self._transcript)))

        await self.push_frame(frame, direction)

    def _flush_assistant_turn(self):
        """Combine accumulated LLM text chunks into a single assistant turn."""
        if self._current_assistant_chunks:
            full_text = "".join(self._current_assistant_chunks).strip()
            if full_text:
                self._transcript.append({"role": "assistant", "content": full_text})
            self._current_assistant_chunks = []

    @property
    def transcript(self) -> list[dict]:
        return self._transcript
