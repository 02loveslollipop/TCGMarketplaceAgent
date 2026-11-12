"""User-facing provider summaries and bounded tool metadata, never raw reasoning."""
import time
import uuid
from urllib.parse import urlsplit
from langchain_core.callbacks import BaseCallbackHandler
from langgraph.config import get_stream_writer


def event_writer():
    try:return get_stream_writer()
    except RuntimeError:return lambda event: None


def tool_start(name, arguments):
    trace=(uuid.uuid4().hex,time.monotonic())
    public={key:str(value)[:1000] for key,value in arguments.items() if key in {
        "query","name","url","card_id","card_ids","supplier",
        "ruleset","format","set_query","card_query","deck_id_or_list_id","language","regulation_mark",
    }}
    if "url" in public and any(key in public["url"].lower() for key in ("token=","key=","signature=","auth=")):
        public["url"]="URL with sensitive parameters omitted"
    event_writer()({"type":"tool","data":{"id":trace[0],"name":name,"status":"loading","input":public,"sources":[]}})
    return trace,public


def tool_end(trace, name, public, status, sources=(), diagnostic=None):
    links=[]
    for source in sources:
        row=source.model_dump(mode="json") if hasattr(source,"model_dump") else source
        if not isinstance(row,dict):continue
        url=str(row.get("url",""));parsed=urlsplit(url)
        if parsed.scheme != "https" or parsed.username or any(key in parsed.query.lower() for key in ("token=","key=","signature=","auth=")):continue
        if url not in [item["url"] for item in links]:links.append({"url":url,"title":str(row.get("title",parsed.hostname))[:160]})
        if len(links)==8:break
    data = {"id":trace[0],"name":name,"status":status,"input":public,"sources":links,"duration_ms":round((time.monotonic()-trace[1])*1000)}
    if diagnostic:
        data["diagnostic"] = {key: diagnostic[key] for key in ("layer", "phase", "outcome", "http_status", "message") if key in diagnostic}
    event_writer()({"type":"tool", "data":data})


def summaries(message):
    content=getattr(message,"content",None)
    if not isinstance(content,list):return ""
    # Only OpenAI's explicitly public summary_text blocks. Never emit raw Mistral
    # thinking chunks, encrypted reasoning, system prompts or reasoning_content.
    return "".join(part.get("text","") for block in content if isinstance(block,dict) and block.get("type")=="reasoning"
                   for part in block.get("summary",[]) if isinstance(part,dict) and part.get("type")=="summary_text")


class ReasoningSummaryCallback(BaseCallbackHandler):
    run_inline = True
    def __init__(self):
        self.writer = event_writer()
        self.id = uuid.uuid4().hex
        self.text = ""
        self.closed = False
        self.completed = False
        self.last_emit = 0.0

    def publish(self, status):
        if status == "loading" and time.monotonic() - self.last_emit < 0.15:
            return
        if self.text and not self.closed:
            self.last_emit = time.monotonic()
            self.writer({"type": "thinking", "data": {"id": self.id, "status": status, "source": "provider_summary", "summary": self.text}})
            if status != "loading":
                self.closed = True

    def on_llm_new_token(self, token, *, chunk=None, **kwargs):
        delta = summaries(getattr(chunk, "message", None))
        if delta:
            self.text = (self.text + delta)[:12000]
            self.publish("loading")

    def on_llm_end(self, response, **kwargs):
        for generation in response.generations[0] if response.generations else []:
            final = summaries(getattr(generation, "message", None))
            if final:
                self.text = final[:12000]
        self.completed = True
        self.publish("complete")

    def on_llm_error(self, error, **kwargs):
        self.completed = True
        self.publish("error")

    def flush(self):
        if not self.completed and self.text.strip():
            self.completed = True
            self.publish("complete")
