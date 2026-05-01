"""Memory client — talks to the Node.js API for prospect lookup, prompt loading, and transcript processing."""

import os
import json
import time
import httpx

NODE_API = os.environ.get("NODE_BASE_URL", "http://localhost:3000")
SARAH_CLIENT_ID = "9d3cd726-c57b-470d-9b18-24361a119496"
SARAH_API_KEY = "2546972a-fe37-46e9-afa9-d2287582ac61"

HEADERS = {
    "X-API-Key": SARAH_API_KEY,
    "Content-Type": "application/json",
}

TIMEOUT = httpx.Timeout(10.0)


async def get_or_create_prospect(phone_number: str, name: str = None) -> dict:
    """Find prospect by phone number, or create a new one."""
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(
                f"{NODE_API}/api/secure/prospects",
                params={"phone": phone_number},
                headers=HEADERS,
            )
            resp.raise_for_status()
            data = resp.json()

            prospects = data if isinstance(data, list) else data.get("prospects", data.get("data", []))
            if isinstance(prospects, list) and len(prospects) > 0:
                print(f"[memory] Found existing prospect for {phone_number}")
                return prospects[0]
            if isinstance(prospects, dict) and prospects.get("id"):
                print(f"[memory] Found existing prospect for {phone_number}")
                return prospects

        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.post(
                f"{NODE_API}/api/secure/prospects",
                headers=HEADERS,
                json={
                    "client_id": SARAH_CLIENT_ID,
                    "phone": phone_number,
                    "name": name or "Unknown",
                    "funnel_stage": "lead",
                    "call_count": 0,
                },
            )
            resp.raise_for_status()
            prospect = resp.json()
            print(f"[memory] Created new prospect for {phone_number}: {prospect.get('id')}")
            return prospect

    except Exception as e:
        print(f"[memory] Prospect lookup/create failed: {e}")
        return {"id": None, "phone": phone_number, "name": name or "Unknown", "call_count": 0}


async def get_system_prompt_with_memory(prospect_id: str) -> str:
    """Fetch system prompt that includes prospect memory context."""
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(
                f"{NODE_API}/clients/{SARAH_CLIENT_ID}/prompt/{prospect_id}",
                headers=HEADERS,
            )
            resp.raise_for_status()

            # Endpoint returns JSON with a "prompt" field
            try:
                data = resp.json()
                prompt = data.get("prompt", resp.text)
            except Exception:
                prompt = resp.text

            if len(prompt) > 100:
                print(f"[memory] Got prompt with memory: {len(prompt)} chars")
                return prompt
    except Exception as e:
        print(f"[memory] Prompt with memory failed: {e}")

    from prompt.loader import get_system_prompt
    print("[memory] Falling back to prompt without prospect memory")
    return await get_system_prompt()


async def save_transcript_for_processing(
    prospect_id: str,
    transcript: list[dict],
    call_type: str = "phone",
) -> dict | None:
    """Save call transcript and trigger Claude analysis."""
    formatted = format_transcript(transcript)

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.post(
                f"{NODE_API}/api/secure/calls",
                headers=HEADERS,
                json={
                    "prospect_id": prospect_id,
                    "client_id": SARAH_CLIENT_ID,
                    "call_type": call_type,
                    "transcript": formatted,
                    "status": "ended",
                },
            )
            resp.raise_for_status()
            call_data = resp.json()
            call_id = call_data.get("id") or call_data.get("call_id")
            print(f"[memory] Call record created: {call_id}")

        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            resp = await client.post(
                f"{NODE_API}/api/secure/calls/{call_id}/process-transcript",
                headers=HEADERS,
                json={
                    "prospect_id": prospect_id,
                    "client_id": SARAH_CLIENT_ID,
                    "transcript": formatted,
                },
            )
            resp.raise_for_status()
            result = resp.json()
            print(f"[memory] Transcript processed by Claude")
            return result

    except Exception as e:
        print(f"[memory] Transcript processing failed: {e}")
        _save_fallback(transcript, prospect_id)
        return None


async def increment_call_count(prospect_id: str):
    """Increment the call count for a prospect."""
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(
                f"{NODE_API}/api/secure/prospects/{prospect_id}",
                headers=HEADERS,
            )
            resp.raise_for_status()
            prospect = resp.json()
            current = prospect.get("call_count", 0) or 0

            await client.patch(
                f"{NODE_API}/api/secure/prospects/{prospect_id}",
                headers=HEADERS,
                json={"call_count": current + 1},
            )
            print(f"[memory] Call count incremented: {current} -> {current + 1}")
    except Exception as e:
        print(f"[memory] Failed to increment call count: {e}")


def format_transcript(messages: list[dict]) -> str:
    """Format transcript list into readable text."""
    lines = []
    for msg in messages:
        speaker = "Sarah" if msg["role"] == "assistant" else "Prospect"
        lines.append(f"{speaker}: {msg['content']}")
    return "\n".join(lines)


def _save_fallback(transcript: list[dict], prospect_id: str):
    """Save transcript to /tmp as fallback when Node.js is unreachable."""
    try:
        ts = int(time.time())
        path = f"/tmp/transcript_{prospect_id}_{ts}.json"
        with open(path, "w") as f:
            json.dump({"prospect_id": prospect_id, "transcript": transcript}, f, indent=2)
        print(f"[memory] Fallback transcript saved to {path}")
    except Exception as e:
        print(f"[memory] Fallback save also failed: {e}")
