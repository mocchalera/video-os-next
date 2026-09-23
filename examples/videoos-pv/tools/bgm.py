"""Original BGM for the Video OS PV. 120 BPM, A minor, 62 s.
Fully synthesized (no samples, no third-party audio) so the track is rights-clean.
Section grid (seconds): 0 cold | 4 raw | 8 see | 16 search | 24 build | 32 refine
| 40 DROP payoff | 50 vertical | 54 breakdown | 58 logo | 62 end
"""
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve
import wave, sys

SR = 48000
BPM = 120
B = 60 / BPM  # 0.5 s
DUR = 64.0
N = int(SR * DUR)
rng = np.random.default_rng(7)

L = np.zeros(N); R = np.zeros(N)
busL = {}; busR = {}

def bus(name):
    if name not in busL:
        busL[name] = np.zeros(N); busR[name] = np.zeros(N)
    return busL[name], busR[name]

def add(name, sig, t, pan=0.0, gain=1.0):
    bl, br = bus(name)
    i = int(t * SR)
    if i >= N: return
    s = sig[: N - i] * gain
    gl = np.cos((pan + 1) * np.pi / 4); gr = np.sin((pan + 1) * np.pi / 4)
    bl[i:i + len(s)] += s * gl * 1.414
    br[i:i + len(s)] += s * gr * 1.414

def addst(name, sl, sr_, t, gain=1.0):
    bl, br = bus(name)
    i = int(t * SR)
    n = min(len(sl), N - i)
    bl[i:i + n] += sl[:n] * gain; br[i:i + n] += sr_[:n] * gain

def filt(x, kind, f, order=2):
    if isinstance(f, (list, tuple)):
        f = [min(max(v, 20), SR / 2 - 100) for v in f]
    else:
        f = min(max(f, 20), SR / 2 - 100)
    return sosfilt(butter(order, f, kind, fs=SR, output='sos'), x)

def tt(d):
    return np.arange(int(d * SR)) / SR

def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12)

def saw(f, t, phase=0.0):
    return 2 * ((f * t + phase) % 1.0) - 1

# ---------------- instruments ----------------
def kick(big=False):
    t = tt(0.9 if big else 0.5)
    f = 42 + 110 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    env = np.exp(-t * (4.5 if big else 7.5))
    s = np.sin(ph) * env
    click = filt(rng.standard_normal(len(t)) * np.exp(-t * 400), 'highpass', 2000) * 0.25
    s = np.tanh((s + click) * (1.8 if big else 1.4))
    return s

def clap():
    t = tt(0.45)
    n = rng.standard_normal(len(t))
    env = np.zeros(len(t))
    for d in (0, 0.011, 0.022):
        i = int(d * SR)
        env[i:] += np.exp(-(t[: len(t) - i]) * (60 if d < 0.02 else 18))
    s = filt(n * env, 'bandpass', [900, 5200]) * 0.9
    body = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30) * 0.3
    return s + body

def hat(open_=False):
    t = tt(0.25 if open_ else 0.06)
    s = filt(rng.standard_normal(len(t)), 'highpass', 7500) * np.exp(-t * (14 if open_ else 70))
    return s * 0.5

def tick(hi=True):
    t = tt(0.08)
    f = 3100 if hi else 2300
    s = np.sin(2 * np.pi * f * t) * np.exp(-t * 180)
    s += np.sin(2 * np.pi * (f * 0.41) * t) * np.exp(-t * 90) * 0.6
    s += filt(rng.standard_normal(len(t)) * np.exp(-t * 500), 'highpass', 3000) * 0.4
    return s * 0.55

def blip(f):
    t = tt(0.07)
    return np.sign(np.sin(2 * np.pi * f * t)) * np.exp(-t * 70) * 0.18

def bass_note(m, d):
    t = tt(d)
    f = mtof(m)
    s = saw(f, t) * 0.6 + np.sin(2 * np.pi * f * t) * 0.8 + np.sin(np.pi * f * t) * 0.3
    env = np.minimum(1, t / 0.005) * np.exp(-t * 3.0)
    cut = 180 + 900 * np.exp(-t * 14)
    # time-varying LPF approximation: blend two filters by envelope
    a = filt(s, 'lowpass', 1100); b = filt(s, 'lowpass', 200)
    k = np.exp(-t * 14)
    out = (a * k + b * (1 - k)) * env
    rel = int(0.02 * SR)
    out[-rel:] *= np.linspace(1, 0, rel)
    return np.tanh(out * 1.6) * 0.7

def pad_chord(notes, d, bright=0.0, voices=5):
    t = tt(d)
    sl = np.zeros(len(t)); sr_ = np.zeros(len(t))
    for m in notes:
        f = mtof(m)
        for v in range(voices):
            det = (v - (voices - 1) / 2) * 0.09
            ff = f * 2 ** (det / 12)
            x = saw(ff, t, phase=rng.random())
            p = (v / (voices - 1)) * 2 - 1 if voices > 1 else 0
            sl += x * (1 - p) * 0.5; sr_ += x * (1 + p) * 0.5
    fc = 900 + 3800 * bright
    sl = filt(sl, 'lowpass', fc); sr_ = filt(sr_, 'lowpass', fc)
    att = 0.35
    env = np.minimum(1, t / att) * np.minimum(1, (d - t) / 0.25).clip(0, 1)
    g = 0.045 / len(notes) * 3
    return sl * env * g, sr_ * env * g

def pluck(m, d=0.3):
    t = tt(d)
    f = mtof(m)
    s = saw(f, t) * 0.5 + np.sign(np.sin(2 * np.pi * f * 1.005 * t)) * 0.3
    a = filt(s, 'lowpass', 5000); b = filt(s, 'lowpass', 700)
    k = np.exp(-t * 22)
    return (a * k + b * (1 - k)) * np.exp(-t * 9) * 0.22

def keys(m, d=1.6):
    t = tt(d)
    f = mtof(m)
    s = np.zeros(len(t))
    for h, a in ((1, 1), (2, 0.45), (3, 0.22), (4, 0.12), (5, 0.06)):
        s += np.sin(2 * np.pi * f * h * t * (1 + 0.0004 * h)) * a * np.exp(-t * (1.6 + h * 0.9))
    s += np.sin(2 * np.pi * f * 7.1 * t) * np.exp(-t * 40) * 0.05  # hammer
    return s * np.minimum(1, t / 0.003) * 0.28

def noise_riser(d, f0=300, f1=9000):
    t = tt(d)
    n = rng.standard_normal(len(t))
    out = np.zeros(len(t))
    seg = int(0.05 * SR)
    for i in range(0, len(t), seg):
        fr = f0 * (f1 / f0) ** (i / len(t))
        chunk = n[max(0, i - 2000): i + seg]
        y = filt(chunk, 'bandpass', [fr * 0.7, fr * 1.4])[-min(seg, len(t) - i):]
        out[i:i + len(y)] = y
    env = (t / d) ** 2.2
    return out * env * 0.5

def reverse_swell(d):
    t = tt(d)
    s = filt(rng.standard_normal(len(t)), 'highpass', 2500) * np.exp(-t * 3.5)
    s += filt(rng.standard_normal(len(t)), 'bandpass', [400, 2000]) * np.exp(-t * 5) * 0.5
    return s[::-1] * 0.4

def impact(big=True):
    t = tt(3.0)
    f = 30 + 70 * np.exp(-t * 6)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 1.3)
    crack = filt(rng.standard_normal(len(t)), 'bandpass', [150, 6000]) * np.exp(-t * 9)
    s = np.tanh(boom * 2.0) * 0.9 + crack * (0.5 if big else 0.3)
    return s

def tape_stop(d=0.6):
    t = tt(d)
    f = mtof(45) * (1 - t / d) ** 2
    s = saw(1, np.cumsum(f) / SR) * (1 - t / d)
    return filt(s, 'lowpass', 1500) * 0.3

def reverb_ir(sec=2.6, damp=3.0, seed=1):
    r = np.random.default_rng(seed)
    t = tt(sec)
    ir = r.standard_normal(len(t)) * np.exp(-t * damp)
    ir = filt(ir, 'lowpass', 6000)
    ir[: int(0.012 * SR)] = 0
    return ir / np.sqrt(np.sum(ir ** 2))

# ---------------- arrangement ----------------
A, C, D, E, F, G = 57, 60, 62, 64, 65, 67  # A3 etc
prog = [  # per bar (2 s): pad chord (midi), bass root
    ([57, 60, 64], 45), ([53, 57, 60], 41), ([55, 60, 64], 48), ([55, 59, 62], 43),
]
prog_tension = [([50, 53, 57], 38), ([53, 57, 60], 41), ([55, 59, 62], 43), ([56, 59, 64], 40)]

def bar_chord(b):
    t0 = b * 2
    if 32 <= t0 < 40:
        return prog_tension[(b - 16) % 4]
    return prog[b % 4]

# Cold open 0-4: drone + clock ticks
dt = tt(4.2)
drone = (np.sin(2 * np.pi * mtof(33) * dt) + 0.5 * np.sin(2 * np.pi * mtof(45) * dt * 1.001)) * np.minimum(1, dt / 1.5) * 0.25
add('pad', filt(drone, 'lowpass', 400), 0.0)
for i in range(8):
    add('tick', tick(i % 2 == 0), i * B, pan=0.35 if i % 2 == 0 else -0.35)
add('fx', reverse_swell(1.0), 3.0)
add('fx', impact(True), 4.0, gain=0.9)
add('kick', kick(True), 4.0, gain=0.9)

# grid pops 4-8 (blips every 8th)
for i in range(16):
    t0 = 4 + i * 0.25
    add('fx', blip(700 + (i * 137) % 900), t0, pan=((i * 0.37) % 1.4) - 0.7, gain=0.8)

# drums per section
def drums(t_start, t_end, style):
    t0 = t_start
    beat = 0
    while t0 < t_end - 1e-6:
        pos = beat % 4
        if style == 'minimal':
            if pos == 0 or (pos == 2 and beat % 8 == 6):
                add('kick', kick(), t0)
            add('hat', hat(), t0 + 0.25, pan=0.2, gain=0.6)
        elif style in ('groove', 'groove+'):
            if pos in (0, 2) or (pos == 3 and beat % 8 == 7 and style == 'groove+'):
                add('kick', kick(), t0)
            if pos == 1 and beat % 8 == 5:
                add('kick', kick(), t0 + 0.25, gain=0.7)
            if pos in (1, 3):
                add('clap', clap(), t0, gain=0.75)
            for s in range(4):
                g = (0.55 if s == 2 else 0.3)
                if style == 'groove+' or s % 2 == 0:
                    add('hat', hat(), t0 + s * 0.125, pan=0.25 if s % 2 else -0.15, gain=g)
            if pos == 3:
                add('hat', hat(True), t0 + 0.25, pan=0.3, gain=0.35)
        elif style == 'half':
            if pos == 0 or (pos == 1 and beat % 8 == 5) or (pos == 3 and beat % 8 == 7):
                add('kick', kick(True), t0, gain=0.9)
            if pos == 2:
                add('clap', clap(), t0, gain=1.0)
            for s in range(2):
                add('hat', hat(), t0 + s * 0.25, pan=0.2 if s else -0.2, gain=0.35)
        t0 += B; beat += 1

drums(4, 8, 'minimal')
drums(8, 16, 'groove')
drums(16, 32, 'groove+')
drums(32, 38, 'groove+')
# snare roll 38-40
n_roll = 16
for i in range(n_roll):
    tr = 38 + 2 * (1 - (1 - i / n_roll) ** 1.25)
    add('clap', clap(), tr, gain=0.25 + 0.6 * i / n_roll)
drums(40, 54, 'half')

# clock ticks keep running quietly through (the film's motif: 'it keeps turning')
for i in range(int(8 / B), int(54 / B)):
    add('tick', tick(i % 2 == 0), i * B, pan=0.5 if i % 2 == 0 else -0.5, gain=0.18)
for i in range(int(54 / B), int(61.5 / B)):
    add('tick', tick(i % 2 == 0), i * B, pan=0.35 if i % 2 == 0 else -0.35, gain=0.5)

# bass 8-54 (8ths, with rests)
for b in range(4, 27):
    t_bar = b * 2
    if t_bar >= 54: break
    chord, root = bar_chord(b)
    if t_bar < 40:
        pattern = [0, 0.5, 0.75, 1.0, 1.5, 1.75] if t_bar >= 16 else [0, 0.75, 1.0, 1.5]
        for p in pattern:
            add('bass', bass_note(root + (12 if p in (0.75, 1.75) else 0), 0.24), t_bar + p)
    else:
        add('bass', bass_note(root, 1.4), t_bar)
        add('bass', bass_note(root, 0.45), t_bar + 1.5)

# pads 8-58
for b in range(4, 29):
    t_bar = b * 2
    chord, root = bar_chord(b)
    if t_bar < 16:
        bright, notes = 0.05, chord
    elif t_bar < 32:
        bright, notes = 0.2, chord
    elif t_bar < 40:
        bright, notes = 0.1 + 0.08 * (b - 16), chord
    elif t_bar < 54:
        bright, notes = 0.75, chord + [chord[0] + 12, chord[1] + 12]
    else:
        bright, notes = 0.02, chord
    sl, sr_ = pad_chord(notes, 2.25, bright)
    addst('pad', sl, sr_, t_bar, gain=1.3 if 40 <= t_bar < 54 else 1.0)

# arp 16-40
for b in range(8, 20):
    t_bar = b * 2
    chord, root = bar_chord(b)
    seq = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[1] + 24, chord[2] + 12, chord[0] + 24, chord[1] + 12, chord[2] + 12]
    for i in range(16):
        m = seq[i % 8]
        add('arp', pluck(m), t_bar + i * 0.125, pan=0.5 * np.sin(i * 0.9), gain=0.8 if i % 4 == 0 else 0.55)

# DROP melody 40-54 (keys)
mel = [  # (time offset from 40, midi, dur)
    (0.0, 76, 1.5), (1.5, 74, 0.5), (2.0, 72, 1.0), (3.0, 69, 1.0),
    (4.0, 72, 1.5), (5.5, 71, 0.5), (6.0, 67, 2.0),
    (8.0, 76, 1.0), (9.0, 79, 1.0), (10.0, 77, 1.5), (11.5, 76, 0.5), (12.0, 74, 2.0),
]
for off, m, d in mel:
    add('keys', keys(m, d + 1.2), 40 + off, pan=0.1)
    add('keys', keys(m - 12, d + 1.2), 40 + off, pan=-0.1, gain=0.5)

# risers & impacts
add('fx', noise_riser(8.0, 200, 11000), 32.0, gain=0.9)
add('fx', reverse_swell(1.5), 38.5, gain=1.0)
add('fx', impact(True), 40.0, gain=1.1)
add('fx', noise_riser(2.0, 500, 8000), 22.0, gain=0.4)
add('fx', reverse_swell(0.75), 15.25, gain=0.6)
add('fx', reverse_swell(0.75), 23.25, gain=0.6)
add('fx', reverse_swell(0.75), 31.25, gain=0.6)
add('fx', impact(False), 16.0, gain=0.35)
add('fx', impact(False), 24.0, gain=0.35)
add('fx', impact(False), 32.0, gain=0.4)
add('fx', impact(False), 50.0, gain=0.45)
add('fx', tape_stop(0.6), 53.4, gain=1.0)
add('fx', reverse_swell(1.2), 56.8, gain=1.0)
add('fx', impact(True), 58.0, gain=1.0)
add('kick', kick(True), 58.0, gain=0.8)
# final chord ring
sl, sr_ = pad_chord([45, 57, 60, 64, 69, 76], 5.5, 0.35)
addst('pad', sl, sr_, 58.0, gain=1.2)
add('keys', keys(69, 4.0), 58.0); add('keys', keys(76, 4.0), 58.0, gain=0.7); add('keys', keys(81, 4.0), 58.0, gain=0.4)

# ---------------- mix ----------------
t_all = np.arange(N) / SR
# sidechain envelope from kick triggers
sc = np.ones(N)
kl, kr = bus('kick')
kenv = np.abs(kl) + np.abs(kr)
kenv = filt(kenv, 'lowpass', 12)
kenv = kenv / (kenv.max() + 1e-9)
sc = 1 - 0.55 * np.clip(kenv * 2.2, 0, 1)

gains = {'kick': 0.95, 'clap': 0.55, 'hat': 0.45, 'tick': 0.6, 'bass': 0.62, 'pad': 1.0,
         'arp': 0.6, 'keys': 0.75, 'fx': 0.7}
send = {'clap': 0.35, 'tick': 0.25, 'pad': 0.3, 'arp': 0.35, 'keys': 0.45, 'fx': 0.3, 'hat': 0.1}
revL = np.zeros(N); revR = np.zeros(N)
for name in busL:
    bl, br = busL[name] * gains.get(name, 1), busR[name] * gains.get(name, 1)
    if name in ('pad', 'bass', 'arp', 'keys'):
        bl = bl * sc; br = br * sc
    L += bl; R += br
    if name in send:
        revL += bl * send[name]; revR += br * send[name]
irL = reverb_ir(seed=1); irR = reverb_ir(seed=2)
wetL = fftconvolve(revL, irL)[:N]; wetR = fftconvolve(revR, irR)[:N]
L += wetL * 0.55; R += wetR * 0.55
# delay on arp for width
al, ar = busL.get('arp', np.zeros(N)), busR.get('arp', np.zeros(N))
d = int(0.375 * SR)
L[d:] += ar[:-d] * 0.18; R[d:] += al[:-d] * 0.18

# gentle master EQ + glue
L = filt(L, 'highpass', 28); R = filt(R, 'highpass', 28)
mx = max(np.abs(L).max(), np.abs(R).max())
L /= mx; R /= mx
L = np.tanh(L * 1.5) / np.tanh(1.5); R = np.tanh(R * 1.5) / np.tanh(1.5)
# fade tail
fade_start = int(61.5 * SR); fade_end = int(63.8 * SR)
env = np.ones(N); env[fade_start:fade_end] = np.linspace(1, 0, fade_end - fade_start); env[fade_end:] = 0
L *= env; R *= env
out = np.stack([L, R], axis=1) * 0.89
pcm = (out * 32767).astype('<i2')
path = sys.argv[1] if len(sys.argv) > 1 else 'bgm.wav'
with wave.open(path, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('wrote', path)
