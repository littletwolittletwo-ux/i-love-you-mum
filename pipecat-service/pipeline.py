import os

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask, PipelineParams
from pipecat.transports.websocket.server import (
    WebsocketServerTransport,
    WebsocketServerParams,
)
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.anthropic.llm import AnthropicLLMService
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair

from processors.fish_tts import FishAudioTTSService
from processors.raw_serializer import RawAudioSerializer
from processors.transcript_collector import TranscriptCollector
from call_session import CallSession


async def create_pipeline(session: CallSession):
    """Build the Pipecat pipeline: Deepgram STT -> Claude -> Fish TTS."""

    transport = WebsocketServerTransport(
        host="0.0.0.0",
        port=8765,
        params=WebsocketServerParams(
            audio_in_enabled=True,
            audio_in_sample_rate=16000,
            audio_out_enabled=True,
            audio_out_sample_rate=44100,
            add_wav_header=False,
            serializer=RawAudioSerializer(sample_rate=16000),
            vad_enabled=True,
            vad_analyzer=SileroVADAnalyzer(),
            vad_audio_passthrough=True,
        ),
    )

    stt = DeepgramSTTService(
        api_key=os.environ["DEEPGRAM_API_KEY"],
        settings=DeepgramSTTService.Settings(
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
        settings=AnthropicLLMService.Settings(
            model="claude-sonnet-4-20250514",
            max_tokens=200,
        ),
    )

    tts = FishAudioTTSService(
        api_key=os.environ["FISH_AUDIO_API_KEY"],
        voice_id=os.environ["FISH_VOICE_ID"],
    )

    collector = TranscriptCollector(on_call_end=session.on_call_end)

    # Build context with system prompt
    messages = [{"role": "system", "content": session.system_prompt}]
    context = LLMContext(messages)
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(context)

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            collector,
            llm,
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
        ),
        cancel_on_idle_timeout=False,
    )

    @transport.event_handler("on_client_connected")
    async def on_connected(transport, client):
        print(f"[pipecat] Client connected")

    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(transport, client):
        print(f"[pipecat] Client disconnected")

    return task, transport
