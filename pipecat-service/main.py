import os
import asyncio
import json

from dotenv import load_dotenv
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

# Fix macOS Python SSL certificate issue
import certifi
os.environ.setdefault("SSL_CERT_FILE", certifi.where())
os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())

from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, WebSocket, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response

from pipecat.pipeline.runner import PipelineRunner
from pipeline import create_pipeline
from twilio_handler import generate_connect_twiml
from twilio_pipeline import create_twilio_pipeline
from call_session import CallSession

TEST_PAGE = """<!DOCTYPE html>
<html>
<head><title>Sarah — voice test</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 20px">
  <h2>Sarah voice test</h2>
  <p id="status">Click Start to connect</p>
  <button id="btn" onclick="start()">Start call</button>
  <button onclick="stop()" style="margin-left:8px">Stop</button>
  <div id="log" style="margin-top:16px;font-size:13px;color:#333;max-height:400px;overflow-y:auto"></div>
  <p style="font-size:12px;color:#888;margin-top:20px">
    Speak naturally. Sarah will respond via Fish Audio TTS.
  </p>
  <script>
    let ws, ctx, workletNode, playCtx, nextPlayTime = 0;
    function log(msg) {
      const d = document.getElementById('log');
      const p = document.createElement('p');
      p.style.margin = '4px 0';
      p.textContent = msg;
      d.prepend(p);
      console.log(msg);
    }
    async function start() {
      document.getElementById('status').textContent = 'Connecting...';
      ws = new WebSocket('ws://localhost:8765');
      ws.binaryType = 'arraybuffer';

      ws.onopen = async () => {
        document.getElementById('status').textContent = 'Connected — speak now';
        log('[connected]');
        ctx = new AudioContext({ sampleRate: 16000 });
        playCtx = new AudioContext({ sampleRate: 44100 });
        nextPlayTime = 0;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mic = ctx.createMediaStreamSource(stream);
        await ctx.audioWorklet.addModule('data:application/javascript,' + encodeURIComponent(`
          class PcmProcessor extends AudioWorkletProcessor {
            process(inputs) {
              const ch = inputs[0][0];
              if (ch) {
                const buf = new Int16Array(ch.length);
                for (let i = 0; i < ch.length; i++)
                  buf[i] = Math.max(-32768, Math.min(32767, ch[i] * 32768));
                this.port.postMessage(buf.buffer, [buf.buffer]);
              }
              return true;
            }
          }
          registerProcessor('pcm-processor', PcmProcessor);
        `));
        workletNode = new AudioWorkletNode(ctx, 'pcm-processor');
        mic.connect(workletNode);
        workletNode.port.onmessage = e => {
          if (ws.readyState === 1) ws.send(e.data);
        };
      };

      ws.onmessage = e => {
        if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
          const view = new DataView(e.data);
          const numSamples = Math.floor(e.data.byteLength / 2);
          if (numSamples === 0) return;
          const buf = playCtx.createBuffer(1, numSamples, 44100);
          const ch = buf.getChannelData(0);
          for (let i = 0; i < numSamples; i++) {
            ch[i] = view.getInt16(i * 2, true) / 32768;
          }
          const src = playCtx.createBufferSource();
          src.buffer = buf;
          src.connect(playCtx.destination);
          const now = playCtx.currentTime;
          if (nextPlayTime < now) nextPlayTime = now;
          src.start(nextPlayTime);
          nextPlayTime += buf.duration;
        }
      };
      ws.onclose = () => {
        document.getElementById('status').textContent = 'Disconnected';
        log('[disconnected]');
      };
      ws.onerror = () => log('[error] WebSocket error');
    }
    function stop() {
      if (ws) ws.close();
      if (ctx) ctx.close();
      if (playCtx) playCtx.close();
      document.getElementById('status').textContent = 'Stopped';
    }
  </script>
</body>
</html>"""


# ── Shared state ──────────────────────────────────────────────────────
active_calls: dict[str, str] = {}  # call_sid -> caller phone number


# ── FastAPI lifespan ──────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("[pipecat] Setting up browser test pipeline...")
    session = CallSession(phone_number=None, call_type="web")
    await session.setup()

    print("[pipecat] Building browser pipeline...")
    task, transport = await create_pipeline(session)

    runner = PipelineRunner(handle_sigint=False)

    print("[pipecat] Starting browser WS pipeline on ws://localhost:8765")
    browser_task = asyncio.create_task(runner.run(task))

    print("[pipecat] FastAPI on http://localhost:8080")
    print("[pipecat] Open http://localhost:8080 to test browser")
    print("[pipecat] Twilio endpoints ready at /twilio/*")

    yield

    # Shutdown: cancel the browser pipeline
    browser_task.cancel()
    try:
        await browser_task
    except asyncio.CancelledError:
        pass


app = FastAPI(lifespan=lifespan)


# ── Routes ────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def test_page():
    return TEST_PAGE


@app.get("/health")
async def health():
    return {"status": "ok", "service": "pipecat-voice"}


@app.post("/twilio/inbound")
async def twilio_inbound(request: Request):
    """Twilio webhook for inbound calls — returns TwiML to connect media stream."""
    form_data = await request.form()
    call_sid = form_data.get("CallSid")
    caller = form_data.get("From")

    if call_sid and caller:
        active_calls[call_sid] = caller
        print(f"[twilio] Inbound call from {caller} (CallSid={call_sid})")

    public_url = os.environ.get("PUBLIC_URL", "").rstrip("/")
    ws_url = public_url.replace("https://", "wss://").replace("http://", "ws://")
    ws_url = f"{ws_url}/twilio/ws"

    twiml = generate_connect_twiml(ws_url)
    return Response(content=twiml, media_type="application/xml")


@app.get("/twilio/outbound-twiml")
async def twilio_outbound_twiml():
    """TwiML for outbound calls — same as inbound, connects to media stream."""
    public_url = os.environ.get("PUBLIC_URL", "").rstrip("/")
    ws_url = public_url.replace("https://", "wss://").replace("http://", "ws://")
    ws_url = f"{ws_url}/twilio/ws"

    twiml = generate_connect_twiml(ws_url)
    return Response(content=twiml, media_type="application/xml")


@app.post("/twilio/call")
async def twilio_outbound_call(request: Request):
    """Trigger an outbound call via Twilio REST API."""
    from twilio.rest import Client

    body = await request.json()
    to_number = body.get("to")
    if not to_number:
        return JSONResponse({"error": "missing 'to' field"}, status_code=400)

    account_sid = os.environ["TWILIO_ACCOUNT_SID"]
    auth_token = os.environ["TWILIO_AUTH_TOKEN"]
    from_number = os.environ["TWILIO_PHONE_NUMBER"]
    public_url = os.environ.get("PUBLIC_URL", "").rstrip("/")

    client = Client(account_sid, auth_token)
    call = client.calls.create(
        to=to_number,
        from_=from_number,
        url=f"{public_url}/twilio/outbound-twiml",
    )

    print(f"[twilio] Outbound call to {to_number}: {call.sid}")
    return {"call_sid": call.sid, "status": call.status}


@app.websocket("/twilio/ws")
async def twilio_ws(websocket: WebSocket):
    """Twilio media stream WebSocket — handles audio for phone calls."""
    await websocket.accept()

    # Read messages until we get the 'start' event with stream metadata
    stream_sid = None
    call_sid = None

    while True:
        raw = await websocket.receive_text()
        msg = json.loads(raw)

        if msg.get("event") == "connected":
            print("[twilio] WebSocket connected event received")
            continue

        if msg.get("event") == "start":
            start_data = msg.get("start", {})
            stream_sid = start_data.get("streamSid")
            call_sid = start_data.get("callSid")
            print(f"[twilio] Stream started: stream_sid={stream_sid}, call_sid={call_sid}")
            break

    if not stream_sid or not call_sid:
        print("[twilio] Missing stream_sid or call_sid, closing")
        await websocket.close()
        return

    # Look up caller phone number from the inbound webhook
    caller_number = active_calls.pop(call_sid, None)
    print(f"[twilio] Caller number for {call_sid}: {caller_number or 'unknown'}")

    # Set up session with prospect memory
    session = CallSession(phone_number=caller_number, call_type="phone")
    await session.setup()

    # Build and run the Twilio pipeline
    task = await create_twilio_pipeline(websocket, stream_sid, call_sid, session)
    runner = PipelineRunner(handle_sigint=False)

    print(f"[twilio] Running pipeline for call {call_sid}")
    await runner.run(task)
    print(f"[twilio] Pipeline finished for call {call_sid}")


# ── Entry point ───────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080)
