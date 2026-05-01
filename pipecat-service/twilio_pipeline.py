"""Twilio pipeline builder — creates a Pipecat pipeline for Twilio phone calls."""

import os

from fastapi import WebSocket

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask, PipelineParams
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketTransport,
    FastAPIWebsocketParams,
)
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.services.deepgram.stt import DeepgramSTTService, LiveOptions
from pipecat.services.anthropic.llm import AnthropicLLMService
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext

from processors.fish_tts import FishAudioTTSService
from processors.transcript_collector import TranscriptCollector
from call_session import CallSession


async def create_twilio_pipeline(
    websocket: WebSocket,
    stream_sid: str,
    call_sid: str,
    session: CallSession,
) -> PipelineTask:
    """Build a Pipecat pipeline for a Twilio phone call.

    Args:
        websocket: The FastAPI WebSocket connection from Twilio.
        stream_sid: Twilio media stream SID.
        call_sid: Twilio call SID.
        session: CallSession with prospect and system prompt already loaded.

    Returns:
        A PipelineTask ready to run.
    """
    serializer = TwilioFrameSerializer(
        stream_sid=stream_sid,
        call_sid=call_sid,
        account_sid=os.environ.get("TWILIO_ACCOUNT_SID"),
        auth_token=os.environ.get("TWILIO_AUTH_TOKEN"),
    )

    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            serializer=serializer,
            vad_enabled=True,
            vad_analyzer=SileroVADAnalyzer(),
            vad_audio_passthrough=True,
        ),
    )

    stt = DeepgramSTTService(
        api_key=os.environ["DEEPGRAM_API_KEY"],
        live_options=LiveOptions(
            model="nova-2",
            language="en-AU",
            smart_format=True,
            endpointing=300,
            utterance_end_ms=1000,
            interim_results=True,
        ),
    )

    llm = AnthropicLLMService(
        api_key=os.environ["ANTHROPIC_API_KEY"],
        model="claude-sonnet-4-20250514",
    )
    llm._max_tokens = 200

    tts = FishAudioTTSService(
        api_key=os.environ["FISH_AUDIO_API_KEY"],
        voice_id=os.environ["FISH_VOICE_ID"],
    )

    collector = TranscriptCollector(on_call_end=session.on_call_end)

    messages = [{"role": "system", "content": session.system_prompt}]
    context = OpenAILLMContext(messages)
    context_aggregator = llm.create_context_aggregator(context)

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            context_aggregator.user(),
            collector,
            llm,
            tts,
            transport.output(),
            context_aggregator.assistant(),
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
        ),
    )

    @transport.event_handler("on_client_connected")
    async def on_connected(transport, websocket):
        print(f"[twilio] Client connected (call_sid={call_sid})")

    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(transport, websocket):
        print(f"[twilio] Client disconnected (call_sid={call_sid})")

    return task
