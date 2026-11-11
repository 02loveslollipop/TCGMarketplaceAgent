"""Build bounded multimodal context for the planner."""
from shared.image_context import MAX_IMAGES

def planning_content(request, history, images):
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
    text=json.dumps({"conversation":context, "request":request,
                     "image_context":{"included":[image["name"] for image in selected], "older_images_omitted":omitted}})
    return [{"type":"text", "text":text}] + [{"type":"image_url", "image_url":{"url":image["data_url"]}} for image in selected]
