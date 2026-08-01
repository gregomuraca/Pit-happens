"""
Build the RAG embedding index over the FIA regulation corpus.

Embeds each chunk in corpus.json (real excerpts from the official 2026 FIA
Formula 1 Sporting Regulations, Section B — see source/fia_2026_sporting_regs.pdf)
using spur-embed (Nomic Embed, 768-dim), and writes rag/index.json.

This runs once, offline. At request time the orchestrator only embeds the
query and does a cosine-similarity lookup against this precomputed index —
no re-embedding of the corpus per request.

Run:
    python3 rag/build_index.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

HERE = os.path.dirname(__file__)


def main():
    client = OpenAI(
        api_key=os.environ["SPUR_API_KEY"],
        base_url=os.environ.get("SPUR_BASE_URL", "https://ai.spuric.com/v1"),
    )

    with open(os.path.join(HERE, "corpus.json")) as f:
        corpus = json.load(f)

    texts = [f"{c['article']} {c['title']}: {c['text']}" for c in corpus]
    resp = client.embeddings.create(model="spur-embed", input=texts)

    index = []
    for chunk, item in zip(corpus, resp.data):
        index.append({**chunk, "embedding": item.embedding})

    with open(os.path.join(HERE, "index.json"), "w") as f:
        json.dump(index, f)

    print(f"Indexed {len(index)} chunks -> rag/index.json ({len(index[0]['embedding'])}-dim)")


if __name__ == "__main__":
    main()
