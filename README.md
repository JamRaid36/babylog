# Jubilee

One-tap log of feeds, pees and poops, shared between two phones.

- `index.html`, `style.css`, `app.js`: the app (plain HTML, CSS and JavaScript, no build step).
- `core.js`: the logic (merging, counts, time wording). `sync.js`: sharing through a private GitHub repo.
- `sw.js`, `manifest.webmanifest`, `bloom-*.png` (drawn in `icon.svg`): lets it be added to a phone's home screen and open with no signal.
- `tests/core.test.mjs`: run with `node --test tests/core.test.mjs`.

The app itself holds no data. Entries live on each phone and, once a sync key is added in Settings,
in a separate private repo as one small file per day. `?demo` shows sample entries without saving anything.
