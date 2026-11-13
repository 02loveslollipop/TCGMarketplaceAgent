"""Build bounded multimodal context for the planner."""
from shared.image_context import MAX_IMAGES


def research_content(value,depth=0):
    """Bound planner context; full retrieved evidence stays in the research cache.

    Metadata and rules text survive. Pricing belongs to the later supplier stage;
    embedded HTML, images, source excerpts and provider payloads need not recur
    in every model call. This does not alter streamed summaries or tool traces.
    """
    if depth>12:return '[Nested evidence omitted]'
    if isinstance(value,dict):
        result={key:research_content(item,depth+1) for key,item in value.items()
                if key not in {'pricing','image','image_url','excerpt','variants_detailed','raw','html'}}
        for key,item in value.items():
            if isinstance(item,list) and len(item)>100:result[key+'_context_omitted']=len(item)-100
        return result
    if isinstance(value,list):
        return [research_content(item,depth+1) for item in value[:100]]
    if isinstance(value,str):
        import re
        value=re.sub(r'<(script|style)\b[^>]*>.*?</\1>','',value,flags=re.S|re.I)
        value=re.sub(r'<[^>]+>',' ',value)
        return value[:14000] if len(value)>14000 else value
    return value

def planning_content(request, history, images, preferences=None):
    """Images are real multimodal input, never base64 inside the text prompt."""
    import json
    context=[]
    previous=[]
    messages=[
        row for row in history
        if row["role"]=="user"
        or row["content"].get("type") not in {"thinking","tool","progress"}
        or (row["content"].get("type") == "thinking" and row["content"].get("data", {}).get("source") == "approach_summary")
    ]
    for row in messages[-20:]:
        content=dict(row["content"])
        previous.extend(content.pop("images", []))
        context.append({"role":row["role"], "content":content})
    # Keep all current attachments and the most recent prior attachments up to the cap.
    remaining=MAX_IMAGES-len(images)
    selected=(previous[-remaining:] if remaining > 0 else []) + list(images)
    omitted=max(0, len(previous)+len(images)-len(selected))
    text=json.dumps({"conversation":context, "request":request, "shopping_preferences":preferences or {},
                     "image_context":{"included":[image["name"] for image in selected], "older_images_omitted":omitted}})
    return [{"type":"text", "text":text}] + [{"type":"image_url", "image_url":{"url":image["data_url"]}} for image in selected]
