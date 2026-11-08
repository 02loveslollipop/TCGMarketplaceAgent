"""Durable LangGraph saver restricted to the app's graph_checkpoints table.

Only the latest checkpoint per execution is retained for this private PoC.
Serialized checkpoint types are handled by LangGraph's own serializer.
"""
import base64
from langgraph.checkpoint.base import BaseCheckpointSaver, CheckpointTuple, get_checkpoint_id


class DatabaseSaver(BaseCheckpointSaver):
    def __init__(self, repo):
        super().__init__()
        self.repo = repo

    def encode(self, value):
        kind, payload = self.serde.dumps_typed(value)
        return [kind, base64.b64encode(payload).decode()]

    def decode(self, value):
        return self.serde.loads_typed((value[0], base64.b64decode(value[1])))

    def get_tuple(self, config):
        row = self.repo.graph_get(config["configurable"]["thread_id"])
        if not row:
            return None
        return CheckpointTuple(config=row["config"], checkpoint=self.decode(row["checkpoint"]),
                               metadata=self.decode(row["metadata"]), parent_config=row.get("parent"),
                               pending_writes=[(task, channel, self.decode(value)) for task, channel, value in row.get("writes",[])])

    def put(self, config, checkpoint, metadata, new_versions):
        thread = config["configurable"]["thread_id"]
        next_config = {"configurable":{"thread_id":thread, "checkpoint_ns":config["configurable"].get("checkpoint_ns", ""), "checkpoint_id":checkpoint["id"]}}
        parent = {"configurable":{key:config["configurable"][key] for key in ("thread_id", "checkpoint_ns", "checkpoint_id") if key in config["configurable"]}}
        self.repo.graph_save(thread, {"config":next_config, "checkpoint":self.encode(checkpoint),
                                     "metadata":self.encode(metadata), "parent":parent, "writes":[]})
        return next_config

    def put_writes(self, config, writes, task_id, task_path=""):
        thread = config["configurable"]["thread_id"]
        row = self.repo.graph_get(thread)
        if row:
            pending = [entry for entry in row.get("writes",[]) if entry[0] != task_id]
            row["writes"] = pending + [(task_id, channel, self.encode(value)) for channel, value in writes]
            self.repo.graph_save(thread, row)

    def list(self, config, *, filter=None, before=None, limit=None):
        value = self.get_tuple(config)
        if value:
            yield value

    async def aget_tuple(self, config):
        return self.get_tuple(config)

    async def aput(self, config, checkpoint, metadata, new_versions):
        return self.put(config, checkpoint, metadata, new_versions)

    async def aput_writes(self, config, writes, task_id, task_path=""):
        self.put_writes(config, writes, task_id, task_path)

    async def alist(self, config, **kwargs):
        for value in self.list(config, **kwargs):
            yield value
