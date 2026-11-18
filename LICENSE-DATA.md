# Licences of the non-code files

The code in this repository is licensed under BSD 2-Clause (`LICENSE`). The files below carry
their own terms.

| File | Licence | Basis |
|---|---|---|
| `web/src/kinesics/profiles.json` (movement parameters) | CC BY-NC 4.0 (Creative Commons Attribution-NonCommercial) | The `same_room` values and all hand and torso values are derived from Seamless Interaction, which is CC BY-NC 4.0. The `video_call` values are aggregate statistics of the CANDOR Corpus |
| `web/src/kinesics/mappings.json` (which joint shows what) | BSD 2-Clause | Its gains are design choices, not derived from data |
| `web/public/riki_minami.vrm` (avatar model "AIりき", author rejoys) | CC BY-NC 4.0 | Released under this licence by the repository owner, who holds the right to do so. This statement supersedes the licence fields embedded in the file |
| `web/test/fixtures/miburi_reference.json` (poses used by tests) | CC BY-NC 4.0 | Output of the MIBURI gesture model, whose checkpoints are CC BY-NC 4.0 |
| `docs/kinesics-movement-measurements.md`, `docs/kinesics-profiles.md` | CC BY-NC 4.0 | They contain measurements derived from Seamless Interaction |
| The other files in `docs/` | BSD 2-Clause | They describe the code and the message protocol |

CC BY-NC 4.0: https://creativecommons.org/licenses/by-nc/4.0/

## Data sources and required notices

**CANDOR.** This work uses the CANDOR Corpus from BetterUp Labs, BetterUp, Inc.
(https://huggingface.co/datasets/betterup/candor-processed). Only aggregate statistics are published
here, as clause 3(b)(iii) of the CANDOR Corpus License, version 2.1, allows; no part of the corpus
is included. Citation: Reece, A., et al. (2023). The CANDOR corpus: Insights from a large multimodal
dataset of naturalistic conversation. *Science Advances*, 9(13), eadf3197.

**Seamless Interaction.** Measurements in `docs/` and the `same_room`, hand and torso values of
`profiles.json` are derived from the Seamless Interaction dataset (Meta), CC BY-NC 4.0. No part of
the dataset is included.

**Unitree G1 model.** Not included. `web/scripts/fetch_g1.sh` downloads it from MuJoCo Menagerie
(BSD-3-Clause, Unitree Robotics).
