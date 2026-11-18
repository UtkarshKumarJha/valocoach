#!/usr/bin/env python3
"""
Checks the minimap projection in frontend/src/utils/mapUtils.js against real deaths.
For each map: projects every death in the label pool with valorant-api.com's calibration
(image x from game Y, image y from game X) and reports the share landing on drawn map pixels.
Healthy maps score >= 97%. Run after Riot adds a map:  python3 scripts/validate_map_projection.py
Needs Pillow. Downloads minimap images (public game data, nothing about players is sent).
"""
import json, glob, io, sys, urllib.request
from PIL import Image

POOL = sys.argv[1] if len(sys.argv) > 1 else 'data/label_pool/matches'
maps = {m['displayName'].lower(): m for m in json.load(urllib.request.urlopen('https://valorant-api.com/v1/maps'))['data'] if m.get('xMultiplier')}

deaths = {}
for fn in glob.glob(f'{POOL}/*.json'):
    match = json.load(open(fn))['match']
    for k in match.get('kill_events', []):
        loc = k.get('victim_death_location')
        if loc: deaths.setdefault((match.get('map') or '').lower(), []).append((loc['x'], loc['y']))

worst = 100.0
for name, pts in sorted(deaths.items()):
    m = maps.get(name)
    if not m:
        print(f'{name:10s} no calibration on valorant-api.com'); continue
    img = Image.open(io.BytesIO(urllib.request.urlopen(m['displayIcon']).read())).convert('RGBA')
    W, H = img.size
    on = sum(1 for x, y in pts
             if 0 <= (u := y * m['xMultiplier'] + m['xScalarToAdd']) < 1
             and 0 <= (v := x * m['yMultiplier'] + m['yScalarToAdd']) < 1
             and img.getpixel((int(u * W), int(v * H)))[3] > 20)
    pct = 100 * on / len(pts)
    worst = min(worst, pct)
    print(f'{name:10s} deaths={len(pts):6d}  on-map {pct:5.1f}%')
sys.exit(0 if worst >= 97 else 1)
