"""Raw PCM audio serializer for browser WebSocket clients."""

from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    OutputAudioRawFrame,
)
from pipecat.serializers.base_serializer import FrameSerializer


class RawAudioSerializer(FrameSerializer):
    """Serializer that handles raw PCM audio bytes.

    - Incoming binary data → InputAudioRawFrame
    - Outgoing OutputAudioRawFrame → raw bytes
    """

    def __init__(self, sample_rate: int = 16000, num_channels: int = 1, **kwargs):
        super().__init__(**kwargs)
        self._sample_rate = sample_rate
        self._num_channels = num_channels

    async def serialize(self, frame: Frame) -> str | bytes | None:
        if isinstance(frame, OutputAudioRawFrame):
            return frame.audio
        return None

    async def deserialize(self, data: str | bytes) -> Frame | None:
        if isinstance(data, bytes) and len(data) > 0:
            return InputAudioRawFrame(
                audio=data,
                sample_rate=self._sample_rate,
                num_channels=self._num_channels,
            )
        return None
