---
license: cc-by-nc-4.0
license_link: https://creativecommons.org/licenses/by-nc/4.0/
tags:
  - clip
  - siglip
  - zero-shot-image-classification
  - image-tagging
---

# clip-tags

Tag embeddings for zero-shot image tagging, made for [Nicegal](https://github.com/centuryofimage/nicegal).
There are 62,951 tags in three kinds: simple (common everyday words), subjects (things you can
see) and vibes (moods, styles, eras).

These tags come from research models trained on unfiltered internet data. They are usually
wrong and can reflect harmful biases.

## Files

`vocabulary.tsv` is the tag list shared by every model, one tag per line after a header row.
Its columns are `term`, `kind` (`simple`, `subject` or `vibe`), `source` (`metaclip` or `wordnet`) and
`sensitivity` (`ok`, `mature` or `blocked`). Terms never contain tabs or line breaks.

Each `.safetensors` file belongs to one model and is named after its id with `/` replaced by `--`.
It holds `embeddings`, float16 text vectors in vocabulary order, and `reference_mean`, the mean
image vector of the reference set described below.

| Model                                                                                         | Dimensions |
| --------------------------------------------------------------------------------------------- | ---------- |
| [facebook/metaclip-2-worldwide-l14](https://huggingface.co/facebook/metaclip-2-worldwide-l14) | 768        |
| [facebook/metaclip-2-worldwide-b16](https://huggingface.co/facebook/metaclip-2-worldwide-b16) | 512        |
| [facebook/metaclip-2-worldwide-b32](https://huggingface.co/facebook/metaclip-2-worldwide-b32) | 512        |
| [google/siglip2-base-patch16-256](https://huggingface.co/google/siglip2-base-patch16-256)     | 768        |

## Scoring

Given a normalized image vector `x` from the same model:

```
score(tag) = cos(tag, x) - dot(tag, reference_mean)
```

Rank each kind separately and keep the top few. The reference term is explained
below.

## Vocabulary

The candidates are the 500,000 entries of [MetaCLIP's metadata](https://github.com/facebookresearch/MetaCLIP)
plus 17,633 concrete WordNet nouns it doesn't have.

Rare words (below 2.0 on the [wordfreq](https://github.com/rspeer/wordfreq) Zipf scale) were
removed unless WordNet lists them as something physical, like an animal, plant, food or object.
Wikipedia titles, duplicates and very short tokens were removed too, leaving 193,027 entries.

An LLM (`typesafe/jev-1.13`) then sorted those into things, vibes, abstract words, names and
foreign phrases. Things and vibes with a probability of at least 0.5 became subjects and vibes.

Specific tags tend to outrank plain ones, so an image of a cat gets "tabby" or "kitten" before
"cat". The simple tags make sure plain words appear too. They come from the 10,000 most common
English words in wordfreq: the same LLM kept the ones that can describe a picture (like car,
art, happy or smile), then WordNet removed words with no noun or adjective sense and folded
plurals and comparatives into their base word. Simple words are listed only as simple.

The result is 2,759 simple tags, 54,403 subjects and 5,789 vibes.

## Sensitivity

The same LLM rated every tag `ok`, `mature` or `blocked`. Mature tags are plain descriptive
terms for adult content. Blocked tags include slurs and crude or sexualizing labels, and should
be hidden by default. The ratings are automatic, so a few harmless words are blocked.

## Text embeddings

Each tag is embedded with the model's text encoder using two prompts, `a photo of {tag}.` and
`{tag}`, and the two normalized vectors are averaged. SigLIP2 text is lowercased first since it
was trained on lowercase text.

## Reference set

Ranking tags by raw cosine similarity doesn't work well. Some tags sit close to nearly every
image, so generic words like "thing" or "picture" end up at the top of every list. This is a
known effect in high-dimensional embedding spaces, often called hubness.

The fix is to compare each tag against a typical image first. Since the tag and image vectors
are normalized, `dot(tag, reference_mean)` equals the tag's average cosine similarity over every
image in the reference set. Subtracting it leaves how much better the tag matches this
particular image than it matches images in general, so a tag only ranks high when something in
the image actually pulls toward it. One mean vector per model holds all of that, so nothing has
to be computed per user.

The reference set decides what counts as typical, so it matters which images go into it. We
tried COCO, a set of ordinary photos. Compared with photos, every screenshot, meme and
illustration looks unusual, so words like "visual novel" or "text file" showed up on a large
share of them.

`reference_mean` here is the mean image vector of 8,000 random images from the
[Reddit Visual Context](https://www.kaggle.com/datasets/hamzasibous/reddit-dataset) dataset,
each squashed to the model's square input size. Reddit images mix photos, screenshots, memes
and drawings, which is closer to a real personal gallery. In a test on 3,000 images from a
personal gallery, "visual novel" was among an image's top subjects 110 times, compared with 687
times against COCO, and about 30% more distinct subjects were used overall. Only the mean
vector is published, not the images.

## Limitations

Subjects work poorly on illustrations and screenshots. Plain words for what is in the picture
are common in any reference set, so they score low, and colors and textures win instead. A pink
anime frame tends to get food tags.

The models also match phrases through their individual words, so a tag can appear because one
of its words fits. The vocabulary is mostly English.

## License

The embeddings come from each model and follow its license: MetaCLIP 2 is CC BY-NC 4.0 and
SigLIP2 is Apache-2.0. The MetaCLIP metadata is CC BY-NC 4.0 and WordNet uses the
[WordNet license](https://wordnet.princeton.edu/license-and-commercial-use). This repository as
a whole is CC BY-NC 4.0 because it uses MetaCLIP's vocabulary.
