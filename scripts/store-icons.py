"""Store icon candidates for the public app.

Even Hub store icon rules (docs/cli/apps, ship/app-submission, 2026-11):
24x24 PNG; every pixel fully transparent or opaque #F4F4F4; lit pixels form
complete 2x2 blocks. So each icon is drawn on a 12x12 grid and doubled, which
satisfies the block rule by construction — and `check()` proves it anyway.
Our own drawings: no Readwise logo ("no unauthorized brand logos").
"""
import sys
from PIL import Image, ImageDraw, ImageFont

LIT = (0xF4, 0xF4, 0xF4, 255)

ICONS = {
    # An open book: two filled pages with text lines carved out, joined at the spine.
    'book': [
        '............',
        '.####..####.',
        '#####..#####',
        '#...#..#...#',
        '#####..#####',
        '#...#..#...#',
        '#####..#####',
        '#...#..#...#',
        '############',
        '.##########.',
        '.....##.....',
        '............',
    ],
    # The G2 itself: two lenses on a bridge, a line of text in each, filling the canvas.
    'glasses': [
        '............',
        '............',
        '#####..#####',
        '#...####...#',
        '#####..#####',
        '#...#..#...#',
        '#####..#####',
        '#...#..#...#',
        '#####..#####',
        '.###....###.',
        '............',
        '............',
    ],
    # The app's own Home: the ▶ focus cursor beside rows of text.
    'list': [
        '............',
        '#...........',
        '##..########',
        '#...........',
        '............',
        '....########',
        '............',
        '............',
        '....########',
        '............',
        '............',
        '....######..',
    ],
}

def render(grid):
    img = Image.new('RGBA', (24, 24), (0, 0, 0, 0))
    px = img.load()
    for y, row in enumerate(grid):
        assert len(row) == 12, row
        for x, c in enumerate(row):
            if c == '#':
                for dy in (0, 1):
                    for dx in (0, 1):
                        px[x * 2 + dx, y * 2 + dy] = LIT
    return img

def check(img):
    px = img.load()
    for y in range(24):
        for x in range(24):
            p = px[x, y]
            assert p in (LIT, (0, 0, 0, 0)), f'pixel {x},{y} is {p}'
            if p == LIT:
                # Must sit in at least one fully lit 2x2 block.
                ok = any(all(0 <= x + dx + ox < 24 and 0 <= y + dy + oy < 24 and px[x + dx + ox, y + dy + oy] == LIT
                             for dx in (0, 1) for dy in (0, 1))
                         for ox in (-1, 0) for oy in (-1, 0))
                assert ok, f'lit pixel {x},{y} not in a 2x2 block'

out = sys.argv[1]
previews = []
for name, grid in ICONS.items():
    img = render(grid)
    check(img)
    img.save(f'{out}/icon-{name}.png')
    # Preview: 10x on near-black (as on the glasses) and on white (as in the store).
    big = img.resize((240, 240), Image.NEAREST)
    dark = Image.new('RGB', (240, 240), (8, 10, 9)); dark.paste(big, (0, 0), big)
    light = Image.new('RGB', (240, 240), (255, 255, 255))
    inv = Image.new('RGBA', (240, 240), (30, 30, 30, 255)); light.paste(inv, (0, 0), big)
    previews.append((name, dark, light, img))

W = 40 + len(previews) * 300
sheet = Image.new('RGB', (W, 620), (236, 237, 235))
d = ImageDraw.Draw(sheet)
try: f = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', 26)
except Exception: f = ImageFont.load_default()
for i, (name, dark, light, img) in enumerate(previews):
    x = 40 + i * 300
    sheet.paste(dark, (x, 30)); sheet.paste(light, (x, 290))
    small = Image.new('RGB', (24, 24), (8, 10, 9)); small.paste(img, (0, 0), img)
    sheet.paste(small.resize((48, 48), Image.NEAREST), (x, 548))
    sheet.paste(small, (x + 70, 560))
    d.text((x + 110, 560), name, font=f, fill=(20, 22, 21))
sheet.save(f'{out}/icon-options.png')
print('ok', list(ICONS))
