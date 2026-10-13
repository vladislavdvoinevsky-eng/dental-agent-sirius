import os

from langchain_ollama import ChatOllama


def make_llm():
    kwargs = dict(
        model=os.getenv("OLLAMA_MODEL", "qwen3:8b"),
        base_url=os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
        num_ctx=int(os.getenv("OLLAMA_NUM_CTX", "40960")),
        temperature=0,
    )
    try:
        return ChatOllama(reasoning=False, **kwargs)  # без длинных размышлений qwen3
    except Exception:
        return ChatOllama(**kwargs)
