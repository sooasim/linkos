#!/usr/bin/env python3
"""Generate apps/web/public/patterns/marks.svg — an ORIGINAL tile of abstract corporate-style emblems
(monogram rings, crests, laurels, seals, facets, interlocks, chevrons, globes, text-free wordmark bars).
Pure geometry, no letters, no real trademarks. Used as a CSS mask so the colour comes from theme tokens.
Deterministic: same seed → same file.  Run: python3 scripts/design/marks.py
"""
import math, random

random.seed(20261007)
W, H, COLS, ROWS = 1200, 900, 6, 5
cw, ch = W / COLS, H / ROWS
S = 'fill="none" stroke="#000" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"'


def poly(cx, cy, r, n, rot=0.0):
    return " ".join(f"{cx + r * math.cos(rot + 2 * math.pi * i / n):.1f},{cy + r * math.sin(rot + 2 * math.pi * i / n):.1f}" for i in range(n))


def ring_monogram(x, y, r):
    a = random.choice([3, 4, 5, 6])
    return (f'<circle cx="{x}" cy="{y}" r="{r}" {S.format(w=2.2)}/><circle cx="{x}" cy="{y}" r="{r*0.82:.1f}" {S.format(w=1)}/>'
            f'<polygon points="{poly(x, y, r*0.5, a, -math.pi/2)}" {S.format(w=2.4)}/>')


def crest(x, y, r):
    p = f"M{x-r*0.7:.1f},{y-r*0.8:.1f} H{x+r*0.7:.1f} V{y:.1f} Q{x+r*0.7:.1f},{y+r*0.75:.1f} {x},{y+r:.1f} Q{x-r*0.7:.1f},{y+r*0.75:.1f} {x-r*0.7:.1f},{y:.1f} Z"
    inner = f'<path d="M{x-r*0.45:.1f},{y-r*0.2:.1f} L{x},{y+r*0.35:.1f} L{x+r*0.45:.1f},{y-r*0.2:.1f}" {S.format(w=2)}/>'
    return f'<path d="{p}" {S.format(w=2.2)}/>' + inner + f'<line x1="{x-r*0.55:.1f}" y1="{y-r*0.5:.1f}" x2="{x+r*0.55:.1f}" y2="{y-r*0.5:.1f}" {S.format(w=1.4)}/>'


def laurel(x, y, r):
    out = []
    for side in (-1, 1):
        for i in range(7):
            t = math.radians(125 + i * 19)  # upper-left → lower-left, mirrored for the right side
            px, py = x + side * r * 0.9 * math.cos(t), y - r * 0.9 * math.sin(t)
            ang = (90 - math.degrees(t)) * side
            out.append(f'<ellipse cx="{px:.1f}" cy="{py:.1f}" rx="{r*0.17:.1f}" ry="{r*0.075:.1f}" transform="rotate({ang:.0f} {px:.1f} {py:.1f})" {S.format(w=1.3)}/>')
    out.append(f'<circle cx="{x}" cy="{y}" r="{r*0.32:.1f}" {S.format(w=2)}/>')
    return "".join(out)


def seal(x, y, r):
    ticks = "".join(
        f'<line x1="{x + r*math.cos(a):.1f}" y1="{y + r*math.sin(a):.1f}" x2="{x + r*1.12*math.cos(a):.1f}" y2="{y + r*1.12*math.sin(a):.1f}" {S.format(w=1.2)}/>'
        for a in [2 * math.pi * i / 36 for i in range(36)])
    return ticks + f'<circle cx="{x}" cy="{y}" r="{r}" {S.format(w=1.6)}/><circle cx="{x}" cy="{y}" r="{r*0.6:.1f}" {S.format(w=1.6)}/><polygon points="{poly(x,y,r*0.35,5,-math.pi/2)}" {S.format(w=1.6)}/>'


def facet(x, y, r):
    top, mid, bot = y - r * 0.55, y - r * 0.15, y + r * 0.85
    return (f'<polygon points="{x-r*0.6:.1f},{mid:.1f} {x-r*0.32:.1f},{top:.1f} {x+r*0.32:.1f},{top:.1f} {x+r*0.6:.1f},{mid:.1f} {x},{bot:.1f}" {S.format(w=2)}/>'
            f'<polyline points="{x-r*0.6:.1f},{mid:.1f} {x+r*0.6:.1f},{mid:.1f}" {S.format(w=1.2)}/>'
            f'<polyline points="{x-r*0.32:.1f},{top:.1f} {x-r*0.12:.1f},{mid:.1f} {x},{bot:.1f} {x+r*0.12:.1f},{mid:.1f} {x+r*0.32:.1f},{top:.1f}" {S.format(w=1.2)}/>')


def interlock(x, y, r):
    sq = lambda rot: f'<polygon points="{poly(x, y, r*0.72, 4, rot)}" {S.format(w=1.8)}/>'
    return sq(0) + sq(math.pi / 4) + f'<circle cx="{x}" cy="{y}" r="{r*0.22:.1f}" {S.format(w=1.6)}/>'


def chevrons(x, y, r):
    return "".join(f'<polyline points="{x-r*0.7:.1f},{y-r*0.4+i*r*0.32:.1f} {x},{y+i*r*0.32:.1f} {x+r*0.7:.1f},{y-r*0.4+i*r*0.32:.1f}" {S.format(w=2.4 - i*0.4)}/>' for i in range(3))


def globe(x, y, r):
    out = [f'<circle cx="{x}" cy="{y}" r="{r}" {S.format(w=2)}/>']
    for k in (0.35, 0.7):
        out.append(f'<ellipse cx="{x}" cy="{y}" rx="{r*k:.1f}" ry="{r}" {S.format(w=1.2)}/>')
    for k in (-0.5, 0, 0.5):
        half = r * math.sqrt(1 - k * k)
        out.append(f'<line x1="{x-half:.1f}" y1="{y+k*r:.1f}" x2="{x+half:.1f}" y2="{y+k*r:.1f}" {S.format(w=1.2)}/>')
    return "".join(out)


def wordmark(x, y, r):
    # a text-free "logotype": emblem dot + bars of varying length (reads as a wordmark at a glance, says nothing)
    out = [f'<rect x="{x-r*1.15:.1f}" y="{y-r*0.32:.1f}" width="{r*0.64:.1f}" height="{r*0.64:.1f}" rx="{r*0.16:.1f}" {S.format(w=2)}/>']
    cx = x - r * 0.38
    for i in range(random.randint(4, 6)):
        w = r * random.uniform(0.12, 0.3)
        hgt = r * random.choice([0.42, 0.42, 0.62])
        out.append(f'<rect x="{cx:.1f}" y="{y + r*0.32 - hgt:.1f}" width="{w:.1f}" height="{hgt:.1f}" rx="{w/2:.1f}" fill="#000"/>')
        cx += w + r * 0.08
    return "".join(out)


def split_square(x, y, r):
    q = r * 0.72
    return (f'<rect x="{x-q:.1f}" y="{y-q:.1f}" width="{2*q:.1f}" height="{2*q:.1f}" rx="{r*0.22:.1f}" {S.format(w=2)}/>'
            f'<line x1="{x-q*0.7:.1f}" y1="{y+q*0.7:.1f}" x2="{x+q*0.7:.1f}" y2="{y-q*0.7:.1f}" {S.format(w=1.6)}/>'
            f'<circle cx="{x-q*0.32:.1f}" cy="{y-q*0.32:.1f}" r="{r*0.16:.1f}" fill="#000"/>')


def orbit(x, y, r):
    return (f'<ellipse cx="{x}" cy="{y}" rx="{r}" ry="{r*0.38:.1f}" transform="rotate(-24 {x} {y})" {S.format(w=1.8)}/>'
            f'<ellipse cx="{x}" cy="{y}" rx="{r}" ry="{r*0.38:.1f}" transform="rotate(36 {x} {y})" {S.format(w=1.4)}/>'
            f'<circle cx="{x}" cy="{y}" r="{r*0.18:.1f}" fill="#000"/>')


def keystone(x, y, r):
    return (f'<path d="M{x-r*0.8:.1f},{y+r*0.7:.1f} V{y-r*0.1:.1f} A{r*0.8:.1f},{r*0.8:.1f} 0 0 1 {x+r*0.8:.1f},{y-r*0.1:.1f} V{y+r*0.7:.1f}" {S.format(w=2)}/>'
            f'<path d="M{x-r*0.4:.1f},{y+r*0.7:.1f} V{y:.1f} A{r*0.4:.1f},{r*0.4:.1f} 0 0 1 {x+r*0.4:.1f},{y:.1f} V{y+r*0.7:.1f}" {S.format(w=1.4)}/>'
            f'<line x1="{x-r:.1f}" y1="{y+r*0.7:.1f}" x2="{x+r:.1f}" y2="{y+r*0.7:.1f}" {S.format(w=2)}/>')


KINDS = [ring_monogram, crest, laurel, seal, facet, interlock, chevrons, globe, wordmark, split_square, orbit, keystone]
marks = []
order = (KINDS * 3)[: COLS * ROWS]
random.shuffle(order)
for i, fn in enumerate(order):
    c, rr = i % COLS, i // COLS
    x = round(cw * c + cw / 2 + (cw * 0.25 if rr % 2 else 0) + random.uniform(-14, 14), 1)
    y = round(ch * rr + ch / 2 + random.uniform(-10, 10), 1)
    x = x - W if x > W else x
    r = random.uniform(30, 44)
    g = fn(x, y, r)
    rot = random.choice([0, 0, -8, 8, 12])
    marks.append(f'<g transform="rotate({rot} {x} {y})">{g}</g>')
    if x + 60 > W:  # wrap horizontally so the tile repeats seamlessly
        marks.append(f'<g transform="translate({-W} 0) rotate({rot} {x} {y})">{g}</g>')

svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">' + "".join(marks) + "</svg>"
open("apps/web/public/patterns/marks.svg", "w").write(svg)
print(len(svg), "bytes,", len(order), "marks")
