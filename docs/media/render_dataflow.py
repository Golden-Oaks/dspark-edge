#!/usr/bin/env python3
"""Render the DSpark remote speculative-decoding data-flow animation.

Server (left) owns the Gemma 4 12B target + KV cache and streams per-token
hidden states to the edge; the edge (right) runs the dspark_gemma4_12b_block7
draft model and streams speculative draft blocks back. The bottom panel is the
companion-CLI transcript: gray-italic = drafted/pending, green = accepted,
red strikethrough = rejected by the target.

Emits PNG frames + a poster frame; ffmpeg (driven by the caller) encodes them.
"""
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

# ----------------------------------------------------------------------------
# Geometry / theme
# ----------------------------------------------------------------------------
W, H = 1280, 720
FPS = 30

BG          = (9, 12, 18)
PANEL       = (16, 20, 28)
PANEL_HEAD  = (20, 26, 36)
BORDER      = (38, 48, 64)
BORDER_SOFT = (28, 36, 49)

FG          = (230, 237, 243)
SUB         = (139, 152, 169)
DIM         = (96, 108, 126)

C_CONFIRM   = (215, 222, 232)   # settled generated text
C_PROMPT    = (128, 140, 158)   # the prompt
C_PENDING   = (107, 118, 135)   # gray italic draft
C_REJECT    = (240, 97, 109)    # red strikethrough
C_ACCEPT    = (86, 211, 100)    # green flash on accept

SERVER_AC   = (88, 166, 255)    # blue  — server / hidden states
EDGE_AC     = (240, 166, 92)    # amber — edge / draft block
WIRE_IDLE   = (43, 52, 68)

FONT_DIR = "/usr/share/fonts/TTF"
NOTO_DIR = "/usr/share/fonts/noto"


def _f(path, size):
    return ImageFont.truetype(path, size)


mono      = lambda s: _f(f"{FONT_DIR}/JetBrainsMonoNerdFontMono-Regular.ttf", s)
mono_bd   = lambda s: _f(f"{FONT_DIR}/JetBrainsMonoNerdFontMono-Bold.ttf", s)
mono_it   = lambda s: _f(f"{FONT_DIR}/JetBrainsMonoNerdFontMono-Italic.ttf", s)
sans      = lambda s: _f(f"{NOTO_DIR}/NotoSans-Regular.ttf", s)
sans_md   = lambda s: _f(f"{NOTO_DIR}/NotoSans-Medium.ttf", s)
sans_bd   = lambda s: _f(f"{NOTO_DIR}/NotoSans-Bold.ttf", s)

F_TITLE   = sans_bd(30)
F_SUB     = sans(16)
F_CARD_T  = sans_bd(15)
F_CARD_B  = mono(13)
F_CARD_S  = sans(12)
F_WIRE    = sans_md(13)
F_STATUS  = sans_bd(17)
F_STEP    = sans_bd(14)
F_HEAD    = sans_bd(14)
F_LEG     = sans(12)
F_MET     = mono(13)
F_CHIP    = mono_bd(12)

# transcript mono fonts
TS = 21
F_TS      = mono(TS)
F_TS_BD   = mono_bd(TS)
F_TS_IT   = mono_it(TS)
ADV       = F_TS.getlength("M")     # monospace advance
LINEH     = 34

# ----------------------------------------------------------------------------
# Decode script — a live Gemma 4 12B run of "The capital of France is"
# Each round: the edge drafts a block; the server verifies against the target.
#   match      = how many leading draft tokens the target accepted
#   correction = the target's replacement for the first rejected token (or None)
# ----------------------------------------------------------------------------
PROMPT = "The capital of France is"
ROUNDS = [
    {"draft": [" Paris", ",", " the", " capital"], "match": 2, "correction": " a"},
    {"draft": [" city", " famous", " for", " its"], "match": 4, "correction": None},
    {"draft": [" art", ",", " fashion", ","],       "match": 4, "correction": None},
    {"draft": [" and", " food", "."],               "match": 1, "correction": " cuisine"},
    {"draft": ["."],                                 "match": 1, "correction": None},
]

for r in ROUNDS:
    r["n"] = len(r["draft"])
    r["accepted"] = r["match"] + (1 if r["correction"] else 0)

# ----------------------------------------------------------------------------
# Timeline
# ----------------------------------------------------------------------------
INTRO_END = 3.4
P_HS, P_CALC, P_DRAFT, P_VER, P_HOLD = 1.0, 0.55, 1.0, 0.45, 1.35
ROUND_DUR = P_HS + P_CALC + P_DRAFT + P_VER + P_HOLD          # 4.35
GEN_END   = INTRO_END + ROUND_DUR * len(ROUNDS)
OUTRO     = 4.0
TOTAL     = GEN_END + OUTRO


def round_time(r):
    return INTRO_END + r * ROUND_DUR


def smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    t = max(0.0, min(1.0, t))
    return tuple(int(round(lerp(c1[i], c2[i], t))) for i in range(3))


# ----------------------------------------------------------------------------
# Layout constants
# ----------------------------------------------------------------------------
MARGIN = 64
CARD_W, CARD_H = 306, 150
CARD_Y = 100
L_CARD = (MARGIN, CARD_Y, MARGIN + CARD_W, CARD_Y + CARD_H)
R_CARD = (W - MARGIN - CARD_W, CARD_Y, W - MARGIN, CARD_Y + CARD_H)

WIRE_L = L_CARD[2] + 6
WIRE_R = R_CARD[0] - 6
TOP_WIRE_Y = CARD_Y + 44
BOT_WIRE_Y = CARD_Y + CARD_H - 44

PANEL_BOX = (MARGIN, 300, W - MARGIN, 688)


# ----------------------------------------------------------------------------
# Drawing helpers
# ----------------------------------------------------------------------------
def rrect(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def glow_rrect(fx, box, r, color, alpha, spread=6, steps=5):
    """Soft glow around a rounded rect, drawn on the RGBA fx overlay."""
    for i in range(steps, 0, -1):
        g = i / steps
        a = int(alpha * (1 - g) * 0.55)
        pad = spread * g
        bb = (box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad)
        fx.rounded_rectangle(bb, radius=r + pad, fill=color + (a,))


def arrowhead(d, x, y, direction, color, size=7):
    if direction > 0:
        d.polygon([(x, y - size), (x + size * 1.4, y), (x, y + size)], fill=color)
    else:
        d.polygon([(x, y - size), (x - size * 1.4, y), (x, y + size)], fill=color)


def text_center(d, cx, y, s, font, fill):
    w = d.textlength(s, font=font)
    d.text((cx - w / 2, y), s, font=font, fill=fill)


# ----------------------------------------------------------------------------
# Phase resolution for a given time
# ----------------------------------------------------------------------------
def active_round(t):
    if t < INTRO_END or t >= GEN_END:
        return None
    r = int((t - INTRO_END) // ROUND_DUR)
    return min(r, len(ROUNDS) - 1)


def phase_of(t, r):
    """Return (name, local_progress 0..1) within round r."""
    lt = t - round_time(r)
    if lt < P_HS:
        return "hs", lt / P_HS
    lt -= P_HS
    if lt < P_CALC:
        return "calc", lt / P_CALC
    lt -= P_CALC
    if lt < P_DRAFT:
        return "draft", lt / P_DRAFT
    lt -= P_DRAFT
    if lt < P_VER:
        return "ver", lt / P_VER
    lt -= P_VER
    return "hold", lt / P_HOLD


# ----------------------------------------------------------------------------
# Transcript model
# ----------------------------------------------------------------------------
def transcript_segments(t):
    """List of (text, kind, t_resolved, alpha). kind: prompt/confirm/pending/reject."""
    segs = [(PROMPT, "prompt", None, 1.0)]
    for r in range(len(ROUNDS)):
        Tr = round_time(r)
        vres = Tr + P_HS + P_CALC + P_DRAFT + P_VER
        rd = ROUNDS[r]
        if t >= vres:
            matched = rd["draft"][:rd["match"]]
            if matched:
                segs.append(("".join(matched), "confirm", vres, 1.0))
            if rd["match"] < rd["n"]:
                segs.append((rd["draft"][rd["match"]], "reject", vres, 1.0))
            if rd["correction"]:
                segs.append((rd["correction"], "confirm", vres, 1.0))
        elif t >= Tr + P_HS:                       # draft decided -> pending shows
            appear = Tr + P_HS
            alpha = smooth((t - appear) / 0.3)
            segs.append(("".join(rd["draft"]), "pending", appear, alpha))
            break
        else:
            break
    return segs


def draw_transcript(d, t):
    x0, y0, x1, y1 = PANEL_BOX
    tx = x0 + 30
    right = x1 - 30
    y = y0 + 96
    x = tx
    caret_x, caret_y = x, y
    for text, kind, tres, alpha in transcript_segments(t):
        wlen = len(text) * ADV
        if x + wlen > right and x > tx:
            x = tx
            y += LINEH
        if kind == "prompt":
            col = C_PROMPT
            font = F_TS
        elif kind == "pending":
            col = mix(PANEL, C_PENDING, alpha)
            font = F_TS_IT
        elif kind == "reject":
            col = C_REJECT
            font = F_TS
        else:  # confirm — green flash settling to normal
            col = mix(C_ACCEPT, C_CONFIRM, smooth((t - tres) / 0.7)) if tres else C_CONFIRM
            font = F_TS
        d.text((x, y), text, font=font, fill=col)
        if kind == "reject":
            ly = y + TS * 0.58
            d.line((x + 1, ly, x + wlen - 1, ly), fill=C_REJECT, width=2)
        x += wlen
        caret_x, caret_y = x, y

    # blinking caret while generating
    if t < GEN_END and int(t * 2) % 2 == 0:
        d.rectangle((caret_x + 1, caret_y + 2, caret_x + 3, caret_y + TS + 2), fill=EDGE_AC)


# ----------------------------------------------------------------------------
# Scene: static-ish structure (drawn every frame on the RGB base)
# ----------------------------------------------------------------------------
def draw_header(d):
    d.text((MARGIN, 30), "DSpark", font=F_TITLE, fill=FG)
    dw = d.textlength("DSpark", font=F_TITLE)
    d.text((MARGIN + dw + 12, 40), "remote speculative decoding", font=sans(20), fill=SUB)
    # Gemma 4 credit line
    y = 74
    d.text((MARGIN, y), "Live decode — ", font=F_SUB, fill=SUB)
    xx = MARGIN + d.textlength("Live decode — ", font=F_SUB)
    d.text((xx, y), "Gemma 4 12B-it", font=sans_bd(16), fill=SERVER_AC)
    xx += d.textlength("Gemma 4 12B-it", font=sans_bd(16))
    d.text((xx, y), " target  ·  draft model ", font=F_SUB, fill=SUB)
    xx += d.textlength(" target  ·  draft model ", font=F_SUB)
    d.text((xx, y), "dspark_gemma4_12b_block7", font=sans_bd(16), fill=EDGE_AC)


def draw_card(d, fx, box, side, accent, title, sub, lines, active, pulse):
    bg = mix(PANEL, PANEL_HEAD, 0.5)
    if active:
        bg = mix(bg, accent, 0.10 + 0.06 * pulse)
        glow_rrect(fx, box, 14, accent, int(70 + 60 * pulse), spread=10, steps=5)
    rrect(d, box, 14, fill=bg, outline=mix(BORDER, accent, 0.5 if active else 0.0), width=2)
    x0, y0, x1, y1 = box
    # accent dot + title
    d.ellipse((x0 + 20, y0 + 20, x0 + 32, y0 + 32), fill=accent)
    d.text((x0 + 44, y0 + 16), title, font=F_CARD_T, fill=FG)
    d.text((x0 + 20, y0 + 44), sub, font=F_CARD_S, fill=SUB)
    yy = y0 + 74
    for ln, col in lines:
        d.text((x0 + 20, yy), ln, font=F_CARD_B, fill=col)
        yy += 22


def draw_wires(d, t):
    # top wire: server -> edge (hidden states)
    d.line((WIRE_L, TOP_WIRE_Y, WIRE_R, TOP_WIRE_Y), fill=WIRE_IDLE, width=2)
    arrowhead(d, WIRE_R, TOP_WIRE_Y, +1, WIRE_IDLE, 6)
    text_center(d, (WIRE_L + WIRE_R) / 2, TOP_WIRE_Y - 24,
                "hidden states  ·  5 tap layers  ·  bf16", F_WIRE, mix(SUB, SERVER_AC, 0.35))
    # bottom wire: edge -> server (draft block)
    d.line((WIRE_L, BOT_WIRE_Y, WIRE_R, BOT_WIRE_Y), fill=WIRE_IDLE, width=2)
    arrowhead(d, WIRE_L, BOT_WIRE_Y, -1, WIRE_IDLE, 6)
    text_center(d, (WIRE_L + WIRE_R) / 2, BOT_WIRE_Y + 12,
                "draft block  ·  speculative tokens + logprobs", F_WIRE, mix(SUB, EDGE_AC, 0.4))


def draw_panel(d, t):
    x0, y0, x1, y1 = PANEL_BOX
    rrect(d, (x0, y0, x1, y1), 14, fill=PANEL, outline=BORDER_SOFT, width=2)
    rrect(d, (x0, y0, x1, y0 + 66), 14, fill=PANEL_HEAD)
    d.rectangle((x0, y0 + 52, x1, y0 + 66), fill=PANEL_HEAD)
    d.line((x0, y0 + 66, x1, y0 + 66), fill=BORDER_SOFT, width=2)
    # header: title + legend
    d.text((x0 + 24, y0 + 16), " companion CLI  —  --watch transcript", font=F_HEAD, fill=FG)
    # legend chips on the right
    legend = [("drafted", C_PENDING, "it"), ("accepted", C_ACCEPT, ""), ("rejected", C_REJECT, "st")]
    lx = x1 - 24
    for label, col, style in reversed(legend):
        w = d.textlength(label, font=F_LEG)
        lx -= w
        if style == "it":
            d.text((lx, y0 + 20), label, font=mono_it(13), fill=col)
        elif style == "st":
            d.text((lx, y0 + 20), label, font=F_LEG, fill=col)
            d.line((lx, y0 + 27, lx + w, y0 + 27), fill=col, width=1)
        else:
            d.text((lx, y0 + 20), label, font=F_LEG, fill=col)
        lx -= 10
        d.ellipse((lx - 12, y0 + 22, lx - 4, y0 + 30), fill=col)
        lx -= 26


# ----------------------------------------------------------------------------
# Packets / status
# ----------------------------------------------------------------------------
def draw_chip(d, fx, cx, cy, w, h, color, label, glow=120):
    box = (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
    glow_rrect(fx, box, h / 2, color, glow, spread=9, steps=5)
    rrect(d, box, h / 2, fill=mix(color, (255, 255, 255), 0.05), outline=mix(color, (255, 255, 255), 0.3), width=1)
    tw = d.textlength(label, font=F_CHIP)
    d.text((cx - tw / 2, cy - 7), label, font=F_CHIP, fill=(10, 12, 18))


def draw_packets(d, fx, t):
    # intro prefill stream
    if INTRO_END - 2.2 <= t < INTRO_END - 0.2:
        for k in range(4):
            pp = ((t - (INTRO_END - 2.2)) / 2.0 * 1.6 - k * 0.22) % 1.3
            if 0 <= pp <= 1:
                x = lerp(WIRE_L + 20, WIRE_R - 20, smooth(pp))
                draw_chip(d, fx, x, TOP_WIRE_Y, 30, 20, SERVER_AC, "h", glow=70)
        return

    r = active_round(t)
    if r is None:
        return
    ph, p = phase_of(t, r)
    rd = ROUNDS[r]
    if ph == "hs":
        x = lerp(WIRE_L + 34, WIRE_R - 34, smooth(p))
        draw_chip(d, fx, x, TOP_WIRE_Y, 66, 24, SERVER_AC, "5×h bf16")
    elif ph == "draft":
        x = lerp(WIRE_R - 40, WIRE_L + 40, smooth(p))
        draw_chip(d, fx, x, BOT_WIRE_Y, 70, 24, EDGE_AC, f"▸ {rd['n']} tok")


def status_line(t):
    """Return (step_number|None, text, color)."""
    r = active_round(t)
    if t < INTRO_END:
        if t < 1.0:
            return (None, "InitSession  —  handshake tap layers / block size", DIM)
        return (None, "Prefill  —  streaming prompt hidden states into draft KV cache", SERVER_AC)
    if r is None:  # outro
        return (None, "target KV cache never left the server  ·  only hidden states crossed the wire", SUB)
    ph, p = phase_of(t, r)
    rd = ROUNDS[r]
    if ph == "hs":
        return (1, "SERVER  ->  EDGE     per-token hidden states  ·  5 tap layers", SERVER_AC)
    if ph == "calc":
        return (None, f"EDGE   dspark draft  ·  block_size 7  ·  proposing {rd['n']} tokens", EDGE_AC)
    if ph == "draft":
        return (2, f"EDGE  ->  SERVER     draft block  ·  {rd['n']} speculative tokens", EDGE_AC)
    if ph == "ver":
        return (None, "SERVER   verify draft against target logits", SUB)
    # hold / verdict
    tail = "full block accepted" if rd["correction"] is None else "1 rejected  ->  target corrected"
    col = C_ACCEPT if rd["correction"] is None else C_REJECT
    return (3, f"VERIFIED   {rd['accepted']}/{rd['n']} accepted  ·  {tail}", col)


def draw_status(d, t):
    step, s, col = status_line(t)
    y = 268
    cx = W / 2
    tw = d.textlength(s, font=F_STATUS)
    badge = 26 if step else 0
    gap = 12 if step else 0
    total = badge + gap + tw
    left = cx - total / 2
    rrect(d, (left - 18, y - 6, left + total + 18, y + 26), 15,
          fill=mix(PANEL, col, 0.10), outline=mix(BORDER, col, 0.35), width=1)
    if step:
        by = y + 10
        d.ellipse((left, by - 13, left + 26, by + 13), fill=mix(PANEL, col, 0.55), outline=col, width=2)
        nw = d.textlength(str(step), font=F_STEP)
        d.text((left + 13 - nw / 2, y + 1), str(step), font=F_STEP, fill=(12, 15, 21))
    d.text((left + badge + gap, y), s, font=F_STATUS, fill=mix(FG, col, 0.5))


def draw_metrics(d, t):
    # cumulative counters up to now
    acc = 0
    drafted = 0
    gen = 0
    r_now = active_round(t)
    for r in range(len(ROUNDS)):
        vres = round_time(r) + P_HS + P_CALC + P_DRAFT + P_VER
        if t >= vres:
            acc += ROUNDS[r]["match"]
            drafted += ROUNDS[r]["n"]
            gen += ROUNDS[r]["accepted"]
    x1 = PANEL_BOX[2] - 30
    y = PANEL_BOX[3] - 34
    pct = int(round(100 * acc / drafted)) if drafted else 0
    s = f"{gen} tokens   ·   drafts accepted {acc}/{drafted} ({pct}%)"
    w = d.textlength(s, font=F_MET)
    d.text((x1 - w, y), s, font=F_MET, fill=DIM)


# ----------------------------------------------------------------------------
# Frame
# ----------------------------------------------------------------------------
def render(t):
    base = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(base)
    fx = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fx)

    # background subtle vertical band separators — none; keep clean

    draw_header(d)

    r = active_round(t)
    ph = phase_of(t, r)[0] if r is not None else None
    server_active = (t < INTRO_END and t >= 0.9) or ph in ("hs", "ver")
    edge_active = ph in ("calc", "draft")
    pulse = 0.5 + 0.5 * math.sin(t * 6)

    draw_card(d, fd, L_CARD, "L", SERVER_AC,
              "SERVER  ·  host (x86-64 / GPU)", "llama-server",
              [("Gemma 4 12B-it  (target)", mix(FG, SERVER_AC, 0.25)),
               ("owns the KV cache", SUB),
               ("--spec-type draft-remote-dspark", DIM)],
              server_active, pulse)
    draw_card(d, fd, R_CARD, "R", EDGE_AC,
              "EDGE  ·  Raspberry Pi 5 (QNX)", "llama-dspark-grpcd",
              [("dspark_gemma4_12b_block7", mix(FG, EDGE_AC, 0.3)),
               ("DSpark draft model", SUB),
               ("local draft KV cache", DIM)],
              edge_active, pulse)

    draw_wires(d, t)
    draw_status(d, t)
    draw_panel(d, t)
    draw_transcript(d, t)
    draw_metrics(d, t)

    # packet glows go on the fx layer (under the chips); composite once...
    _sink = ImageDraw.Draw(Image.new("RGBA", (W, H)))   # discards solid pass here
    draw_packets(_sink, fd, t)
    out = Image.alpha_composite(base.convert("RGBA"), fx).convert("RGB")
    # ...then the solid chips are drawn on top of the composited frame.
    od = ImageDraw.Draw(out)
    draw_packets(od, ImageDraw.Draw(Image.new("RGBA", (W, H))), t)

    # intro/outro global fades
    a = 1.0
    if t < 0.7:
        a = smooth(t / 0.7)
    elif t > TOTAL - 0.8:
        a = smooth((TOTAL - t) / 0.8)
    if a < 1.0:
        out = Image.blend(Image.new("RGB", (W, H), BG), out, a)
    return out


def main():
    outdir = sys.argv[1]
    os.makedirs(outdir, exist_ok=True)
    n = int(TOTAL * FPS)
    for i in range(n):
        t = i / FPS
        img = render(t)
        img.save(f"{outdir}/f{i:05d}.png")
        if i % 30 == 0:
            print(f"frame {i}/{n}  t={t:.2f}", flush=True)
    # poster: a verdict frame in round 4 (shows red strikethrough + green correction)
    poster_t = round_time(3) + P_HS + P_CALC + P_DRAFT + P_VER + 0.5
    render(poster_t).save(f"{outdir}/poster.png")
    print(f"DONE {n} frames, poster t={poster_t:.2f}, total={TOTAL:.2f}s")


if __name__ == "__main__":
    main()
