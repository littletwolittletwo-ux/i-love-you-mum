"""Twilio TwiML generation utilities. No Pipecat dependencies."""


def generate_connect_twiml(ws_url: str) -> str:
    """Generate TwiML XML that connects the call to a WebSocket media stream.

    Args:
        ws_url: The WebSocket URL for Twilio to stream audio to.

    Returns:
        TwiML XML string.
    """
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        "<Connect>"
        f'<Stream url="{ws_url}" />'
        "</Connect>"
        "</Response>"
    )
