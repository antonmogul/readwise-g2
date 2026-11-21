import sys
from PIL import Image, ImageFilter, ImageDraw, ImageFont
SP, OUT = sys.argv[1], sys.argv[2]
BG = (6, 10, 7)
GREEN = (90, 255, 120)

def font(size):
    for f in ['/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial.ttf']:
        try: return ImageFont.truetype(f, size)
        except Exception: pass
    return ImageFont.load_default()

def lens(name, scale=2):
    """A glasses framebuffer as the eye sees it: lit pixels glowing on black."""
    src = Image.open(f'{SP}/shots/{name}.png').convert('RGBA')
    a = src.split()[3]
    lit = Image.new('RGB', src.size, GREEN)
    base = Image.new('RGB', src.size, BG)
    base.paste(lit, mask=a)
    base = base.resize((src.width * scale, src.height * scale), Image.LANCZOS)
    glow = base.filter(ImageFilter.GaussianBlur(6 * scale // 2))
    out = Image.blend(base, glow, 0.0)
    out = Image.composite(base, glow, base.convert('L').point(lambda v: 255 if v > 40 else 0))
    return out

def captioned(img, title, sub, w=None):
    pad = 48
    w = w or img.width + pad * 2
    canvas = Image.new('RGB', (w, img.height + pad * 2 + 110), (12, 14, 13))
    d = ImageDraw.Draw(canvas)
    # rounded "lens" panel
    x0 = (w - img.width) // 2
    d.rounded_rectangle([x0 - 18, pad - 18, x0 + img.width + 18, pad + img.height + 18], 28, fill=BG, outline=(30, 48, 34), width=2)
    canvas.paste(img, (x0, pad))
    d.text((pad, pad + img.height + 40), title, font=font(34), fill=(235, 240, 236))
    d.text((pad, pad + img.height + 84), sub, font=font(24), fill=(150, 160, 153))
    return canvas

FRAMES = [
    ('01-home', 'Home', 'What arrived, what is quick, the Feed, what is half read'),
    ('02-recent', 'Recently added', 'Swipe through the list; press to open'),
    ('03-preview', 'A preview first', 'The publisher’s note, labelled as theirs — no AI until you ask'),
    ('04-menu', 'Summarise on request', 'Tap, hold, Summarise — with your own Claude key'),
    ('05-summarising', 'Claude summarising…', 'The preview stays readable while it works'),
    ('06-summary', 'The AI summary', 'What it argues and concludes — enough to decide'),
    ('07-reader', 'The full article', 'One full-width sheet; the glasses scroll a line per swipe'),
    ('q12', 'Always knows your place', 'Title and progress on every sheet; reopen where you left off'),
    ('09-archived', 'Hold to archive & next', 'Archived in Readwise; the next article is already open'),
    ('r12', 'The end', 'Swipe past the last line and it is marked read'),
    ('11-feed', 'Feed, sorted by Claude', 'Themes, not publications — most of the feed left out'),
    ('13-continue', 'Continue reading', 'Everything half read, in one place'),
]
for i, (name, title, sub) in enumerate(FRAMES, 1):
    captioned(lens(name), title, sub).save(f'{OUT}/glasses-{i:02d}-{title.lower().replace(" ", "-").replace("…","").replace("&","and").replace(",","").strip("-")}.png', optimize=True)

# The walkthrough GIF: one decision, end to end.
seq = ['01-home', '02-recent', '03-preview', '04-menu', '05-summarising', '06-summary', '07-reader', 'q12', '09-archived']
titles = {n: (t, s) for n, t, s in FRAMES}
gif = [captioned(lens(n), *titles[n]).convert('P', palette=Image.ADAPTIVE, colors=64) for n in seq]
durations = [1800, 1600, 2200, 1800, 1400, 2600, 2200, 2200, 2400]
gif[0].save(f'{OUT}/walkthrough.gif', save_all=True, append_images=gif[1:], duration=durations, loop=0, optimize=True)

# Phone screenshots, trimmed of the browser's grey margin, on a soft card.
def phone(name):
    im = Image.open(f'{SP}/shots/{name}.png').convert('RGB')
    w, h = im.size
    card = Image.new('RGB', (w + 80, h + 80), (238, 238, 236))
    mask = Image.new('L', im.size, 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, w, h], 48, fill=255)
    card.paste(im, (40, 40), mask)
    return card
for name, out in [('p1-library', 'phone-library'), ('p4-summary', 'phone-ai-summary'), ('p5-settings', 'phone-settings')]:
    phone(name).save(f'{OUT}/{out}.png', optimize=True)

# One overview image: six glasses frames and the phone summary.
picks = ['01-home', '03-preview', '04-menu', '06-summary', 'q12', '09-archived']
tiles = [captioned(lens(n), *titles[n]) for n in picks]
tw, th = tiles[0].size
ph = phone('p4-summary')
ph = ph.resize((int(ph.width * (th * 3) / ph.height), th * 3))
W = tw * 2 + ph.width + 60
H = th * 3 + 170
sheet = Image.new('RGB', (W, H), (12, 14, 13))
d = ImageDraw.Draw(sheet)
d.text((48, 40), 'Readwise Reader on Even Realities G2', font=font(56), fill=(240, 244, 241))
d.text((48, 108), 'Browse, preview, summarise on request, read, archive — on your glasses', font=font(30), fill=(150, 160, 153))
for i, t in enumerate(tiles):
    sheet.paste(t, ((i % 2) * tw, 170 + (i // 2) * th))
sheet.paste(ph, (tw * 2 + 30, 170))
sheet.save(f'{OUT}/overview.png', optimize=True)
print('done')
