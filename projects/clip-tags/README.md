# clip-tags

Scripts that build [bep256/clip-tags](https://huggingface.co/bep256/clip-tags): a tag vocabulary
and per-model text embeddings for zero-shot image tagging. The model card there explains the
method.

## Rebuilding

Use Python 3.13 and run everything from this folder. Downloads and intermediate files go in
`data/`, which is not committed.

```sh
uv venv --python cp313 .venv
uv pip install --python .venv -r ../../nicegal-server/requirements-directml.txt \
  numpy tokenizers pyarrow pillow safetensors wordfreq nltk
```

1. Download [MetaCLIP's metadata](https://raw.githubusercontent.com/facebookresearch/MetaCLIP/main/metaclip/metaclip1/metadata.json)
   to `data/metaclip1_metadata.json`, and WordNet with
   `.venv/Scripts/python -c "import nltk; nltk.download('wordnet', download_dir='data/nltk')"`.
2. `filter_terms.py` flags junk and adds WordNet nouns, writing `data/terms.parquet`.
3. `classify_all.py` and `classify_sensitive.py` label each entry's kind and sensitivity with an
   LLM on OpenRouter. They need `OPENROUTER_API_KEY` and can be rerun to resume.
   `classify_simple.py` then asks which of wordfreq's most common English words make simple
   tags, and `classify_simple.py --finalize` filters them into `data/simple_words.json`.
4. Download the [Reddit Visual Context](https://www.kaggle.com/datasets/hamzasibous/reddit-dataset)
   zip into `data/reddit/`, then for each model (`l14`, `b16`, `b32`, `siglip2`):
   `embed_reference.py <model> reddit reddit 8000` and `build_tags.py <model>`.
   Models are read from the Hugging Face cache, so run Nicegal with each one once first.
5. `export_hf.py` assembles the repository in `data/hf/` using `hf_card.md` as its README.
   Upload it with `hf upload bep256/clip-tags data/hf .`.

`models.py` holds each model's preprocessing, and `decide_batch.py` and `laya_eval.py` hold the
LLM prompts and endpoint used in step 3. `laya_eval2.py`, `score_terms.py`, `compare_ranking.py`,
`embed_terms.py` and `load_images.py` are experiments from choosing the method and are not
needed to rebuild.
