"""Manages state for a single call — prospect, memory, transcript processing."""

from memory.client import (
    get_or_create_prospect,
    get_system_prompt_with_memory,
    save_transcript_for_processing,
    increment_call_count,
)
from prompt.loader import get_system_prompt


class CallSession:
    """One instance per call. Handles prospect lookup and post-call memory."""

    def __init__(self, phone_number: str = None, call_type: str = "phone"):
        self.phone_number = phone_number
        self.call_type = call_type
        self.prospect = None
        self.system_prompt = None

    async def setup(self) -> str:
        """Load prospect and build system prompt. Call before pipeline starts."""
        if self.phone_number:
            self.prospect = await get_or_create_prospect(self.phone_number)
            prospect_id = self.prospect.get("id")
            name = self.prospect.get("name", "Unknown")
            call_count = self.prospect.get("call_count", 0)
            print(f"[session] Prospect: {name} ({prospect_id})")
            print(f"[session] Call count: {call_count}")

            if prospect_id:
                self.system_prompt = await get_system_prompt_with_memory(prospect_id)
                print(f"[session] System prompt: {len(self.system_prompt)} chars (with memory)")
            else:
                self.system_prompt = await get_system_prompt()
                print(f"[session] System prompt: {len(self.system_prompt)} chars (prospect has no id)")
        else:
            self.system_prompt = await get_system_prompt()
            print(f"[session] System prompt: {len(self.system_prompt)} chars (no prospect)")

        return self.system_prompt

    async def on_call_end(self, transcript: list[dict]):
        """Called by TranscriptCollector when the call ends."""
        print(f"[session] Call ended — {len(transcript)} transcript turns")

        if not transcript:
            print("[session] Empty transcript, skipping memory update")
            return

        if not self.prospect or not self.prospect.get("id"):
            print("[session] No prospect linked — transcript not saved")
            return

        prospect_id = self.prospect["id"]

        await increment_call_count(prospect_id)

        print("[session] Sending transcript to Claude for analysis...")
        result = await save_transcript_for_processing(
            prospect_id,
            transcript,
            self.call_type,
        )

        if result:
            analysis = result.get("claude_analysis", result.get("analysis", {}))
            if isinstance(analysis, dict):
                print(f"[session] Detection risk: {analysis.get('detection_risk_score', 'n/a')}/10")
                print(f"[session] Next action: {analysis.get('recommended_next_action', 'none')}")
            print(f"[session] Memory updated for {self.prospect.get('name')}")
        else:
            print("[session] Memory processing failed — transcript saved but not analysed")
