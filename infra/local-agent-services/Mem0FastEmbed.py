# Minimal overlay for Mem0 abb81c88, mem0/embeddings/fastembed.py (Apache-2.0).
# Forward supported model_kwargs so the cached real ONNX model works offline.
from typing import Literal, Optional
from mem0.configs.embeddings.base import BaseEmbedderConfig
from mem0.embeddings.base import EmbeddingBase
from fastembed import TextEmbedding


class FastEmbedEmbedding(EmbeddingBase):
    def __init__(self, config: Optional[BaseEmbedderConfig] = None):
        super().__init__(config)
        self.config.model = self.config.model or "thenlper/gte-large"
        self.dense_model = TextEmbedding(
            model_name=self.config.model, **self.config.model_kwargs
        )
        if not self.config.embedding_dims:
            self.config.embedding_dims = self.dense_model.embedding_size

    def embed(self, text, memory_action: Optional[Literal["add", "search", "update"]] = None):
        text = text.replace("\n", " ")
        embeddings = list(self.dense_model.embed(text))
        return embeddings[0].tolist()
