"""Public execution steps contain tool names, never headers or tool arguments."""
from langgraph.config import get_stream_writer


def progress(step: str, message: str):
    try:
        writer=get_stream_writer()
    except RuntimeError:
        return
    writer({"type":"progress","data":{"step":step,"message":message}})
