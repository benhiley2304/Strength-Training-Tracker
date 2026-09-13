# Strength Training Tracker

Minimal, self-contained workout tracker for a rolling 12-session upper/lower programme.

## Render deployment

1. Sign in to Render.
2. Select **New > Blueprint**.
3. Connect `benhiley2304/Strength-Training-Tracker`.
4. Render will detect `render.yaml`.
5. Apply the Blueprint and open the generated site URL.

No build step, Python runtime, environment variables, or database is required.

## Data storage

Training data is stored in browser `localStorage`. It persists on the same browser and site origin, but does not automatically sync between devices. Use **Export JSON** to create backups and **Import JSON** to restore them.

## Strength tracking

Logged compound sets generate estimated 1RM history using the Epley formula. Weighted pull-ups and dips use bodyweight plus external load, then display the added-load equivalent.
