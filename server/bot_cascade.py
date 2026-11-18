"""Cascaded Pipecat bot with turn cues: speech-to-text, a language model, text-to-speech, over SmallWebRTC.

The pipeline is Pipecat's usual cascade, with the turn-cue path added:

    transport.input() -> rtvi -> stt -> user turns -> llm -> tap -> tts
        -> cascaded speech stage -> tag stage -> relay -> transport.output() -> assistant turns

The tap reports the language model's text past the text-to-speech service; the cascaded
speech stage turns the service's audio and word times into speech contexts; the tag stage
runs the turn-cue generator on them; the relay sends each turn state to clients as an RTVI
server message, ``bot-turn-cue`` (turncue/, turn-cue-protocol.md).

An observer (turncue/census.py) records when each step of a reply happens against when its
audio is sent, and the relay records every message, so a session can be checked afterwards
(tools/census_report.py).

Run:  python bot_cascade.py     (serves the signalling endpoint on http://localhost:7860)
Then: npm run dev  in web    (the page proxies /api/offer to the bot).

Environment (read from server/.env, which git ignores):
  DEEPGRAM_API_KEY, OPENAI_API_KEY, CARTESIA_API_KEY   required
  OPENAI_MODEL        default gpt-5.5, run without reasoning
  CARTESIA_VOICE      a Cartesia voice id
  KINESICS_TURN_CUES=0/1  send turn cues to clients (default 1)
  KINESICS_RECORD=0/1 record every session (default 1).  The page shows that it is on.
  KINESICS_RECORD_DIR where the session folders go (default out/sessions)
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frameworks.rtvi.observer import RTVIObserver
from pipecat.processors.frameworks.rtvi.processor import RTVIProcessor
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.openai.responses.llm import (
    OpenAIResponsesLLMService,
    OpenAIResponsesReasoningConfig,
)
from pipecat.transports.base_transport import TransportParams

from kinesics_core.playout import AudioPlayout, PlayoutObserver
from turncue import (
    ActionTagToRTVI, CascadeSpeechStage, CensusObserver, CensusRecorder, ReplyTextTap, TagService,
    TurnCueGenerator, default_clock,
)

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

RECORD = os.environ.get("KINESICS_RECORD", "1") == "1"
TURN_CUES = os.environ.get("KINESICS_TURN_CUES", "1") == "1"
RECORD_DIR = Path(os.environ.get("KINESICS_RECORD_DIR") or HERE / "out" / "sessions")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.5")
CARTESIA_VOICE = os.environ.get("CARTESIA_VOICE", "9287676d-f0cc-423f-ac03-3b3c7242f091")  # Cartesia voice "Allen - Modern Voice"
IN_RATE, OUT_RATE = 16000, 24000

# Replies of mixed length on purpose: one word, one sentence, and two or three sentences.
# The longer ones give pauses between sentences, which the turn cues must tell from the end.
SYSTEM_PROMPT = (
    "You are a friendly humanoid robot having a spoken conversation with one person. "
    "Your words are read aloud, so write plain speech: no lists, no symbols, no emoji. "
    "Vary the length of your replies the way people do. Sometimes answer with a single word "
    "or a short phrase, often with one sentence, and now and then with two or three sentences. "
    "Never go beyond three sentences. Start by greeting the person in one short sentence."
)


async def bot(runner_args: RunnerArguments):
    missing = [k for k in ("DEEPGRAM_API_KEY", "OPENAI_API_KEY", "CARTESIA_API_KEY") if not os.environ.get(k)]
    if missing:
        raise SystemExit(f"missing in server/.env: {', '.join(missing)}")
    recorder = None
    try:
        transport = await create_transport(
            runner_args,
            {"webrtc": lambda: TransportParams(audio_in_enabled=True, audio_out_enabled=True)},
        )
        rtvi = RTVIProcessor()
        stt = DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"])
        llm = OpenAIResponsesLLMService(
            api_key=os.environ["OPENAI_API_KEY"],
            settings=OpenAIResponsesLLMService.Settings(
                model=OPENAI_MODEL,
                reasoning=OpenAIResponsesReasoningConfig(effort="none"),
            ),
        )
        tts = CartesiaTTSService(
            api_key=os.environ["CARTESIA_API_KEY"],
            settings=CartesiaTTSService.Settings(voice=CARTESIA_VOICE),
        )
        context = LLMContext([{"role": "system", "content": SYSTEM_PROMPT}])
        # Default turn strategies: voice activity or a transcript starts the user's turn,
        # the local Smart Turn model ends it.
        user_turns, assistant_turns = LLMContextAggregatorPair(
            context, user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer())
        )

        playout = AudioPlayout()   # how much of the agent's audio waits in the output transport
        observers = [RTVIObserver(rtvi)]
        if RECORD:
            recorder = CensusRecorder(RECORD_DIR, meta={
                "engine": "cascade",
                "stt": f"deepgram {stt._settings.model}",
                "llm": f"openai {OPENAI_MODEL}, no reasoning",
                "tts": f"cartesia {tts._settings.model}, voice {CARTESIA_VOICE}",
                "turn_detection": "pipecat defaults: Silero voice activity, local Smart Turn v3",
                "turn_cues": TURN_CUES,
                "host": os.environ.get("KINESICS_HOST", "local"),
                "audio_in_sample_rate": IN_RATE, "audio_out_sample_rate": OUT_RATE,
            })
            observers.append(CensusObserver(transport.input(), transport.output(), recorder))
            logger.info(f"recording this session to {recorder.folder}")

            @user_turns.event_handler("on_user_turn_inference_triggered")
            async def on_inference(aggregator, strategy, speculation=None):
                recorder.event("inference_triggered", speculative=speculation is not None, strategy=type(strategy).__name__)

            @user_turns.event_handler("on_user_turn_speculation_cancelled")
            async def on_cancelled(aggregator, *args):
                recorder.event("speculation_cancelled")

        # One clock for the cues and the recording, so the two can be compared directly.
        clock = recorder.now_ms if recorder else default_clock
        observers.append(PlayoutObserver(transport.output(), playout))
        if TURN_CUES:
            turn_cue_path = [
                ReplyTextTap(clock=clock), tts, CascadeSpeechStage(playout, clock=clock),
                TagService(TurnCueGenerator()), ActionTagToRTVI(clock=clock, recorder=recorder),
            ]
        else:
            turn_cue_path = [tts]
        pipeline = Pipeline([transport.input(), rtvi, stt, user_turns, llm, *turn_cue_path, transport.output(), assistant_turns])
        task = PipelineTask(
            pipeline,
            params=PipelineParams(
                enable_metrics=True,
                audio_in_sample_rate=IN_RATE,
                audio_out_sample_rate=OUT_RATE,
            ),
            observers=observers,
        )

        @rtvi.event_handler("on_client_ready")
        async def on_client_ready(rtvi):
            # The page shows which bot it talks to and that the session is recorded.
            await rtvi.send_server_message({"t": "stats", "engine": "cascade", "recording": recorder is not None})
            if recorder:
                recorder.event("client_ready")
            playout.begin()   # the client is connected: from here on the transport keeps the audio it is given
            await task.queue_frames([LLMRunFrame()])  # the bot greets first

        @transport.event_handler("on_client_connected")
        async def on_client_connected(transport, client):
            logger.info("client connected")

        @transport.event_handler("on_client_disconnected")
        async def on_client_disconnected(transport, client):
            logger.info("client disconnected")
            await task.cancel()

        runner = PipelineRunner(handle_sigint=runner_args.handle_sigint)
        await runner.run(task)
    finally:
        if recorder:
            recorder.close()
            logger.info(f"recording closed: {recorder.folder}")


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
