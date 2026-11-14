# My Closet Assistant

A photo inventory of your clothes, shoes, bags and accessories: what you own, where each piece
is kept and whether it's in the closet right now. It can also put together an **outfit of the
day** for any occasion. It's a web app you install to the Home Screen of an iPhone or Android
phone, hosted free on GitHub Pages, with no account or subscription. (Built the same way as
the Kitchen app.)

## What it does

### Inventory
- **Add item** takes **up to 4 photos** per piece (front, back, care label, detail), from the
  camera or the photo library (you can pick several at once). The first photo is the cover; tap
  a photo to view it full size or make it the cover.
- **Claude describes it for you**: name, category, type, colours, pattern, material, brand and
  size (read from the label), season, dress code (1 very casual → 5 formal) and a style note used
  for matching. Anything it fills in is tinted blue; what you type is never overwritten.
- Each item has a **location** (Wardrobe – hanging rail, Drawer 2, Shoe boxes, Storage box – off
  season…) and a **status**: In closet, In the laundry, At dry cleaner / tailor, Lent out,
  Packed / travelling, To donate / sell. New items start in the location and category you used last.
- The grid **groups and sorts** by category, location, colour, status, least worn, recently added
  or name. Category chips along the top show how many of each you have. Search finds colour,
  brand, material, notes… Filter by location or status for a quick inventory check
  ("what's at the dry cleaner?", "what's in the off-season box?").

### Outfit of the day
- **Style me** → pick an occasion (Normal work day, Formal dinner, Light casual brunch, Dinner night
  with friends, Date night, Wedding guest, Job interview, Beach / holiday… or type your own),
  optionally the weather and any wishes ("comfy shoes, no black").
- **Build around a piece**: choose one or more items (a top, a skirt, a pair of shoes) and every
  suggestion includes them. From any item you can also tap **Style an outfit**.
- Claude suggests **three complete outfits** from your closet, each with why it works and a styling
  tip, plus a "wardrobe idea" when a missing piece would help. By default it only uses what's
  **in the closet now** (not in the laundry or lent out); switch to *Everything I own* if you like.
- **Wear this today** logs the outfit and updates each piece's times worn / last worn, so Claude
  avoids repeating recent combinations. **Save look** keeps it for later. Both show under
  *Saved & worn looks*.
- Without a Claude key (or offline) you still get simple matches by dress code and season.

## Claude (optional, recommended)

1. Create an account at **console.anthropic.com**, add some credit (the minimum is plenty), and set a
   **monthly spend limit** under *Settings → Limits*.
2. *API keys → Create key*, copy it, and paste it in the app's *Settings → Claude API key*.

Two models can be chosen separately in Settings:
- **Describing photos**: Claude Haiku 5.5 by default, roughly 0.05p per item (4 photos).
- **Styling outfits**: Claude Sonnet 5.5 by default, roughly 2–4p per suggestion with a closet
  of about 100 items; Haiku 5.5 is well under 1p but has a less sure eye.

Describing sends that item's photos to Anthropic; styling sends only the **text** list of your
items (no photos). The key stays on that phone and is never put in backup files.

## Backups and a new phone

Everything is stored on the phone. **Deleting the app from the Home Screen deletes its data**, so
now and then use *Settings → Save a full backup* (to Files / iCloud Drive / Google Drive). Backups
include every photo, so they can be large (roughly 0.5–1 MB per item).
To restore, *Settings → Restore from a backup…* and choose *Restore: replace this phone's closet*,
or *Only add missing or newer items* to keep what's on the phone.

Also in Settings: **Send the list as a message** (grouped by location) and **Export a spreadsheet (CSV)**.

## Putting it online (one-time)

1. Create a **public** repository called `closet` at github.com/new (no README).
2. On the PC, in this project folder: `python publish.py`. It checks the version stamps, pushes
   the app, then waits until https://jgwh21.github.io/closet/ serves every file.
3. The first time only: on GitHub, *Settings → Pages → Deploy from a branch → main / (root)*,
   then run `python publish.py --check`.

## Installing

- **iPhone**: open https://jgwh21.github.io/closet/ in **Safari** → *Share → Add to Home Screen*.
  Use it from the Home Screen icon, which keeps its own storage.
- **Android**: open the address in **Chrome** → *⋮ → Add to Home screen / Install app*.

## Updating the app

Commit the change, then `python build-upload.py --bump` (raises the version everywhere), commit
again, and `python publish.py`. Phones pick it up next time the app is opened online. Your items
are untouched.

## Testing locally on the PC

```bash
python -m http.server 8767 --bind 127.0.0.1 --directory closet
```

Then open http://localhost:8767. Data made there is separate from the phone's.

## Known limits

- Styling works from Claude's text descriptions of your items, not the photos, to keep it fast and
  cheap. Good descriptions (colours, style notes) give better outfits.
- No sharing with friends or live sync between phones yet; a backup file is the way to copy a closet.

## Files

- `index.html`, `styles.css`: the interface
- `js/app.js`: screens, grid, item editor, outfit of the day, settings, updates
- `js/ai.js`: describing photos and styling outfits with Claude
- `js/stylist.js`: simple outfit matching without Claude
- `js/share.js`: backups, CSV and text export
- `js/images.js`: shrinking photos and making thumbnails
- `js/db.js`: on-device storage (IndexedDB)
- `sw.js`, `manifest.webmanifest`, `icons/`: offline support and installability
- `../tools/make-icons.py`: redraws the icons
