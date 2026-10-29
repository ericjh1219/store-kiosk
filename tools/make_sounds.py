"""声音模版：用程序合成背景音乐和音效（原创，不涉及版权），输出到 ../sounds/*.mp3。

用法：python3 tools/make_sounds.py        （需要 numpy 和 ffmpeg）
后台「设置 → 声音」的「选模版」就是用这些文件。改了这里要重新运行再提交。
"""
import os, subprocess, sys
import numpy as np

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sounds")
rng = np.random.default_rng(7)   # 固定随机数，每次生成都一样


# ---------- 基本工具 ----------
def midi(name):
    """'C4' → 60，'F#5' → 78"""
    names = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    n = names[name[0]] + (1 if "#" in name else -1 if name[1] == "b" else 0)
    return 12 * (int(name[-1]) + 1) + n


def hz(n):
    return 440.0 * 2 ** (((midi(n) if isinstance(n, str) else n) - 69) / 12)


def secs(d):
    return np.arange(int(SR * d)) / SR


def fade(x, a=0.004, r=0.03):
    """头尾加一点淡入淡出，避免爆音"""
    x = x.copy(); na, nr = min(int(SR * a), len(x)), min(int(SR * r), len(x))
    if na: x[:na] *= np.linspace(0, 1, na)
    if nr: x[-nr:] *= np.linspace(1, 0, nr)
    return x


def additive(f, dur, partials, vib=0.0, vib_rate=5.5, vib_delay=0.15):
    """加法合成：partials = [(倍频, 音量, 衰减时间秒 或 None=不衰减)]；f 可以是数组（滑音）"""
    t = secs(dur)
    f = np.full(len(t), f) if np.isscalar(f) else f[: len(t)]
    if vib:
        f = f * (1 + vib * np.clip((t - vib_delay) / 0.3, 0, 1) * np.sin(2 * np.pi * vib_rate * t))
    phase = 2 * np.pi * np.cumsum(f) / SR
    out = np.zeros(len(t))
    for ratio, amp, decay in partials:
        if ratio * f.max() > SR / 2 - 500: continue
        e = np.exp(-t / decay) if decay else 1.0
        out += amp * e * np.sin(ratio * phase)
    return fade(out)


def spectral(x, fn):
    """用 FFT 做静态滤波，fn(频率数组) → 增益"""
    X = np.fft.rfft(x, axis=0); f = np.fft.rfftfreq(len(x), 1 / SR)
    g = fn(f)
    return np.fft.irfft(X * (g[:, None] if X.ndim == 2 else g), n=len(x), axis=0)


def lowpass(x, fc, order=2):
    return spectral(x, lambda f: 1 / np.sqrt(1 + (f / fc) ** (2 * order)))


def highpass(x, fc, order=2):
    return spectral(x, lambda f: 1 / np.sqrt(1 + (fc / np.maximum(f, 1)) ** (2 * order)))


def noise(dur):
    return rng.standard_normal(int(SR * dur))


# ---------- 乐器 ----------
def pluck(n, dur, bright=1.0):          # 拨弦（吉他 / 古筝的感觉）
    return additive(hz(n), dur, [(k, bright ** (k - 1) / k ** 1.3, 1.6 / (1 + 0.9 * k)) for k in range(1, 11)])


def guzheng(n, dur):                     # 古筝：拨弦 + 一点揉弦
    f0 = hz(n); t = secs(dur)
    f = f0 * (1 + 0.006 * np.clip((t - 0.25) / 0.4, 0, 1) * np.sin(2 * np.pi * 5 * t))
    return additive(f, dur, [(k, 0.85 ** (k - 1) / k, 2.2 / (1 + 0.7 * k)) for k in range(1, 9)])


def marimba(n, dur):
    return additive(hz(n), min(dur, 1.2), [(1, 1, 0.45), (3.93, 0.25, 0.08), (9.2, 0.08, 0.03)])


def bell(n, dur=1.4, decay=0.9):         # 铃铛 / 钟琴
    return additive(hz(n), dur, [(1, 1, decay), (2.0, 0.35, decay * 0.6), (2.76, 0.25, decay * 0.4), (5.4, 0.12, decay * 0.2)])


def epiano(n, dur):                      # 电钢琴（FM）
    f = hz(n); t = secs(dur)
    idx = 1.2 * np.exp(-t / 0.35)
    x = np.sin(2 * np.pi * f * t + idx * np.sin(2 * np.pi * f * t)) * np.exp(-t / 1.6)
    x *= 1 + 0.15 * np.sin(2 * np.pi * 4.5 * t)
    return fade(x, 0.003, 0.15)


def bass(n, dur):
    t = secs(dur); f = hz(n)
    x = (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t) + 0.08 * np.sin(6 * np.pi * f * t))
    return fade(x * (0.55 + 0.45 * np.exp(-t / 0.25)), 0.005, 0.06)


def square(n, dur, duty=0.5, decay=None):  # 8-bit 方波
    t = secs(dur); f = hz(n)
    x = np.where((f * t) % 1 < duty, 1.0, -1.0) * 0.5
    if decay: x *= np.exp(-t / decay)
    return fade(lowpass(x, 6000), 0.002, 0.02)


def triangle(n, dur):
    t = secs(dur); ph = (hz(n) * t) % 1
    return fade((4 * np.abs(ph - 0.5) - 1) * 0.8, 0.002, 0.02)


def brass(n, dur, vib=0.0):              # 小号 / 长号：亮度先升后降
    f0 = hz(n); t = secs(dur)
    bright = np.clip(t / 0.05, 0, 1) * (0.75 + 0.25 * np.exp(-t / 0.2))
    phase = 2 * np.pi * np.cumsum(f0 * (1 + vib * np.clip((t - 0.2) / 0.3, 0, 1) * np.sin(2 * np.pi * 5.5 * t))) / SR
    x = sum((bright ** (k * 0.7)) / k * np.sin(k * phase) for k in range(1, 12) if k * f0 < SR / 2 - 500)
    return fade(x, 0.01, 0.08)


def kick(gain=1.0):
    t = secs(0.35)
    f = 50 + 110 * np.exp(-t / 0.04)
    return gain * fade(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.12), 0.001, 0.05)


def snare(gain=1.0):
    t = secs(0.25)
    x = highpass(noise(0.25), 1500) * 0.5 * np.exp(-t / 0.06) + 0.4 * np.sin(2 * np.pi * 185 * t) * np.exp(-t / 0.05)
    return gain * fade(x, 0.001, 0.03)


def hat(gain=1.0, dur=0.06):
    return gain * fade(highpass(noise(dur), 7000) * 0.4 * np.exp(-secs(dur) / (dur / 3)), 0.001, 0.01)


def woodblock(n="E6", gain=1.0):
    return gain * additive(hz(n), 0.12, [(1, 1, 0.03), (2.6, 0.3, 0.015)])


def drum(gain=1.0):                      # 中国大鼓「咚」
    t = secs(0.6)
    f = 55 + 90 * np.exp(-t / 0.05)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.22) + lowpass(noise(0.6), 900) * 0.25 * np.exp(-t / 0.05)
    return gain * fade(x, 0.001, 0.08)


def gong(dur=1.6, gain=1.0):             # 小锣 + 镲「锵」
    t = secs(dur); f0 = 430 * (1 + 0.04 * (1 - np.exp(-t / 0.4)))   # 锣的音会往上飘
    x = additive(f0, dur, [(1, 1, 0.9), (1.47, 0.6, 0.6), (2.09, 0.5, 0.5), (2.56, 0.35, 0.4), (3.14, 0.3, 0.3), (4.2, 0.2, 0.2)])
    crash = highpass(noise(dur), 5000, 4) * 0.3 * np.exp(-t / 0.25)
    return gain * fade(x * 0.6 + crash, 0.001, 0.1)


# ---------- 混音 ----------
class Mix:
    def __init__(self, dur):
        self.buf = np.zeros((int(SR * dur) + 1, 2))

    def add(self, x, at, gain=1.0, pan=0.0):
        i = int(SR * at)
        if i >= len(self.buf): return
        x = x[: len(self.buf) - i] * gain
        a = (pan + 1) * np.pi / 4
        self.buf[i:i + len(x), 0] += x * np.cos(a)
        self.buf[i:i + len(x), 1] += x * np.sin(a)


def reverb(x, seconds=1.4, wet=0.18, tone=5000):
    """人工混响：衰减的噪声当作房间回声，左右声道不一样，听起来比较宽"""
    t = secs(seconds)
    out = x.copy()
    for ch in range(x.shape[1]):
        ir = lowpass(noise(seconds), tone) * np.exp(-t / (seconds / 5))
        ir /= np.sqrt(np.sum(ir ** 2))
        n = len(x[:, ch]) + len(ir)
        wetsig = np.fft.irfft(np.fft.rfft(x[:, ch], n) * np.fft.rfft(ir, n), n)[: len(x)]
        out[:, ch] += wet * wetsig
    return out


def loop_ready(mix, loop_len):
    """把超出循环长度的余音叠回开头，循环播放时接得上"""
    n = int(SR * loop_len); b = mix.buf
    tail = b[n:]
    b = b[:n].copy(); b[: len(tail)] += tail[:n]
    return b


def master(x, target_rms=None, peak_db=-1.0):
    x = np.asarray(x, float)
    if target_rms:
        x *= target_rms / (np.sqrt(np.mean(x ** 2)) + 1e-9)
        x = np.tanh(x * 1.2) / 1.2 * 1.0   # 软限幅，突然的大声不会爆
    return x * (10 ** (peak_db / 20) / (np.abs(x).max() + 1e-9))


def save(name, x, bitrate):
    os.makedirs(OUT, exist_ok=True)
    x = np.clip(x, -1, 1)
    ch = 1 if x.ndim == 1 else x.shape[1]
    pcm = (x * 32767).astype("<i2").tobytes()
    path = os.path.join(OUT, name + ".mp3")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", str(ch), "-i", "-",
                    "-c:a", "libmp3lame", "-b:a", bitrate, path], input=pcm, check=True)
    print(f"{name:16s} {len(x) / SR:5.1f}s  {os.path.getsize(path) // 1024:4d}KB")


def music(name, loop_len, build, rms=0.12, verb=0.18):
    m = Mix(loop_len + 2.0)
    build(m)
    b = loop_ready(m, loop_len)
    n, tail = int(SR * loop_len), int(SR * 1.5)
    b = reverb(np.vstack([b, np.zeros((tail, 2))]), wet=verb)   # 混响的余音也叠回开头，循环接得上
    b[:tail] += b[n:]; b = b[:n]
    save(name, master(b, rms), "128k")


def sfx(name, dur, build, verb=0.12):
    m = Mix(dur)
    build(m)
    b = reverb(m.buf, seconds=0.8, wet=verb)
    save(name, master(b.mean(axis=1)), "96k")


# ---------- 背景音乐 ----------
def bars(bpm, events):
    """events: [(小节, 拍, 音, 拍数)] → [(秒, 音, 秒数)]"""
    b = 60 / bpm
    return [(((bar * 4) + beat) * b, n, d * b) for bar, beat, n, d in events]


def bgm_sunny(m):   # 轻快午后：C G Am F | C G F C，100 BPM
    bpm = 100; b = 60 / bpm
    chords = [["C3", "C4", "E4", "G4"], ["G2", "B3", "D4", "G4"], ["A2", "C4", "E4", "A4"], ["F2", "C4", "F4", "A4"],
              ["C3", "C4", "E4", "G4"], ["G2", "B3", "D4", "G4"], ["F2", "C4", "F4", "A4"], ["C3", "C4", "E4", "G4"]]
    for i, ch in enumerate(chords):
        t0 = i * 4 * b
        m.add(bass(ch[0], 1.4 * b), t0, 0.5); m.add(bass(ch[0], 0.9 * b), t0 + 2 * b, 0.4)
        for k, idx in enumerate([1, 2, 3, 2, 1, 2, 3, 2]):
            m.add(pluck(ch[idx], 0.9), t0 + k * b / 2, 0.22, pan=-0.3 + 0.2 * (k % 2))
            m.add(hat(0.25 if k % 2 else 0.12), t0 + k * b / 2, pan=0.4)
        m.add(kick(0.35), t0); m.add(kick(0.25), t0 + 2 * b)
    mel = [(0, 0, "E5", 1), (0, 1, "G5", 1), (0, 2, "A5", .5), (0, 2.5, "G5", .5), (0, 3, "E5", 1),
           (1, 0, "D5", 1.5), (1, 1.5, "B4", .5), (1, 2, "D5", 1), (1, 3, "G4", 1),
           (2, 0, "C5", 1), (2, 1, "E5", 1), (2, 2, "A5", 1), (2, 3, "G5", .5), (2, 3.5, "E5", .5),
           (3, 0, "F5", 1.5), (3, 1.5, "E5", .5), (3, 2, "C5", 2),
           (4, 0, "E5", 1), (4, 1, "G5", 1), (4, 2, "C6", 1), (4, 3, "B5", .5), (4, 3.5, "A5", .5),
           (5, 0, "G5", 1.5), (5, 1.5, "D5", .5), (5, 2, "B4", 1), (5, 3, "D5", 1),
           (6, 0, "A5", 1), (6, 1, "G5", .5), (6, 1.5, "F5", .5), (6, 2, "E5", 1), (6, 3, "D5", 1),
           (7, 0, "C5", 3)]
    for t, n, d in bars(bpm, mel):
        m.add(bell(n, max(d, 0.6) + 0.6, 0.6), t, 0.3, pan=0.15)


PENTA = [midi(n) for n in ["C3", "D3", "E3", "G3", "A3", "C4", "D4", "E4", "G4", "A4", "C5", "D5", "E5", "G5", "A5", "C6"]]


def bgm_teahouse(m):   # 中国风茶楼：五声音阶古筝，72 BPM
    bpm = 72; b = 60 / bpm
    roots = [0, 4, 3, 0, 0, 4, 1, 0]   # C A G C C A D C（PENTA 的位置）
    for i, r in enumerate(roots):
        t0 = i * 4 * b
        m.add(pluck(PENTA[r] - 12, 3.5, 0.6), t0, 0.35, pan=-0.1)
        for k, off in enumerate([0, 2, 4, 5, 6, 5, 4, 2]):
            m.add(guzheng(PENTA[r + off], 1.6), t0 + k * b / 2, 0.16, pan=-0.35)
        m.add(woodblock("E6", 0.25), t0, pan=0.5)
        m.add(woodblock("B5", 0.12), t0 + 2 * b, pan=0.5)
    mel = [(0, 0, "E5", 1.5), (0, 1.5, "G5", .5), (0, 2, "A5", 1), (0, 3, "G5", 1),
           (1, 0, "E5", 1), (1, 1, "D5", .5), (1, 1.5, "C5", .5), (1, 2, "A4", 2),
           (2, 0, "G4", 1), (2, 1, "A4", .5), (2, 1.5, "C5", .5), (2, 2, "D5", 1.5), (2, 3.5, "E5", .5),
           (3, 0, "D5", 2), (3, 2, "C5", 2),
           (4, 0, "G5", 1), (4, 1, "A5", .5), (4, 1.5, "G5", .5), (4, 2, "E5", 1), (4, 3, "D5", 1),
           (5, 0, "E5", 1.5), (5, 1.5, "G5", .5), (5, 2, "A5", 1), (5, 3, "C6", 1),
           (6, 0, "A5", 1), (6, 1, "G5", .5), (6, 1.5, "E5", .5), (6, 2, "D5", 1), (6, 3, "E5", .5), (6, 3.5, "D5", .5),
           (7, 0, "C5", 4)]
    for t, n, d in bars(bpm, mel):
        if d >= 1.5 * b:   # 长音用「轮指」：快速重复拨弦
            k = 0
            while k * b / 4 < d - b / 4:
                m.add(guzheng(n, 0.8), t + k * b / 4, 0.22 if k == 0 else 0.11, pan=0.2); k += 1
        else:
            m.add(guzheng(midi(n) - 2, 0.15), t - 0.06, 0.08, pan=0.2)   # 倚音：先轻轻带一下下面的音
            m.add(guzheng(n, d + 1.2), t, 0.26, pan=0.2)


def bgm_lofi(m):   # 轻松 Lo-fi：电钢琴七和弦，82 BPM
    bpm = 82; b = 60 / bpm
    chords = [["F2", "A3", "C4", "E4"], ["E2", "G3", "B3", "D4"], ["D2", "F3", "A3", "C4"], ["C2", "E3", "G3", "B3"]] * 2
    for i, ch in enumerate(chords):
        t0 = i * 4 * b
        for at, length in [(0, 1.5), (1.5, 2.0)]:
            for j, n in enumerate(ch[1:]):
                m.add(epiano(n, length * b + 0.4), t0 + at * b + j * 0.012, 0.2, pan=-0.2 + 0.2 * j)
        m.add(bass(ch[0], 1.8 * b), t0, 0.55); m.add(bass(ch[0], 1.2 * b), t0 + 2.5 * b, 0.45)
        m.add(kick(0.5), t0); m.add(kick(0.35), t0 + 2.5 * b)
        m.add(lowpass(snare(0.35), 3000), t0 + b); m.add(lowpass(snare(0.35), 3000), t0 + 3 * b)
        for k in range(8):
            m.add(hat(0.12 if k % 2 else 0.2), t0 + k * b / 2 + (0.05 if k % 2 else 0), pan=0.3)   # 摇摆的节奏
    top = [(4, 0, "E5", 1), (4, 1.5, "C5", 1), (5, 0, "D5", 1), (5, 1.5, "B4", 1), (6, 0, "C5", 1), (6, 1.5, "A4", 1),
           (7, 0, "G4", 2), (7, 2, "B4", 1)]
    for t, n, d in bars(bpm, top):
        m.add(epiano(n, d + 0.8), t, 0.18, pan=0.25)


def game_bouncy(m):   # 欢乐挑战：马林巴 + 鼓，128 BPM
    bpm = 128; b = 60 / bpm
    chords = [["C3", "E4", "G4", "C5"], ["A2", "E4", "A4", "C5"], ["F2", "F4", "A4", "C5"], ["G2", "G4", "B4", "D5"]] * 2
    for i, ch in enumerate(chords):
        t0 = i * 4 * b
        for beat in range(4):
            m.add(bass(ch[0] if beat % 2 == 0 else midi(ch[0]) + 7, 0.8 * b), t0 + beat * b, 0.5)
            m.add(kick(0.6) if beat % 2 == 0 else snare(0.45), t0 + beat * b)
            if beat % 2: [m.add(pluck(n, 0.4, 0.7), t0 + beat * b, 0.12, pan=-0.3) for n in ch[1:]]
        for k in range(8): m.add(hat(0.18 if k % 2 else 0.1), t0 + k * b / 2, pan=0.35)
    mel = [(0, 0, "G5", .5), (0, .5, "E5", .5), (0, 1, "G5", .5), (0, 1.5, "C6", .5), (0, 2, "B5", .5), (0, 2.5, "G5", .5), (0, 3, "E5", 1),
           (1, 0, "A5", .5), (1, .5, "E5", .5), (1, 1, "A5", .5), (1, 1.5, "C6", .5), (1, 2, "B5", .5), (1, 2.5, "A5", .5), (1, 3, "E5", 1),
           (2, 0, "F5", .5), (2, .5, "A5", .5), (2, 1, "C6", .5), (2, 1.5, "A5", .5), (2, 2, "G5", .5), (2, 2.5, "F5", .5), (2, 3, "A5", 1),
           (3, 0, "G5", .5), (3, .5, "B5", .5), (3, 1, "D6", .5), (3, 1.5, "B5", .5), (3, 2, "G5", 1), (3, 3, "D5", 1),
           (4, 0, "E5", .5), (4, .5, "G5", .5), (4, 1, "C6", .5), (4, 1.5, "G5", .5), (4, 2, "E6", 1), (4, 3, "D6", 1),
           (5, 0, "C6", .5), (5, .5, "A5", .5), (5, 1, "E5", .5), (5, 1.5, "A5", .5), (5, 2, "C6", 1), (5, 3, "B5", 1),
           (6, 0, "A5", .5), (6, .5, "C6", .5), (6, 1, "A5", .5), (6, 1.5, "F5", .5), (6, 2, "A5", .5), (6, 2.5, "C6", .5), (6, 3, "F5", 1),
           (7, 0, "G5", .5), (7, .5, "A5", .5), (7, 1, "B5", .5), (7, 1.5, "D6", .5), (7, 2, "B5", 1), (7, 3, "G5", 1)]
    for t, n, d in bars(bpm, mel):
        m.add(marimba(n, d + 0.5), t, 0.4, pan=0.15)


def game_8bit(m):   # 8-bit 游戏机：方波旋律 + 三角波低音，150 BPM
    bpm = 150; b = 60 / bpm
    roots = ["C3", "F3", "G3", "C3", "A2", "F3", "G3", "G3"]
    for i, r in enumerate(roots):
        t0 = i * 4 * b
        for k in range(8):
            m.add(triangle(midi(r) + (12 if k % 2 else 0), b / 2 * 0.9), t0 + k * b / 2, 0.35)
            m.add(hat(0.2, 0.03), t0 + k * b / 2)
        m.add(kick(0.5), t0); m.add(kick(0.5), t0 + 2 * b)
        m.add(snare(0.35), t0 + b); m.add(snare(0.35), t0 + 3 * b)
    mel = [(0, 0, "E5", .5), (0, .5, "G5", .5), (0, 1, "C6", 1), (0, 2, "G5", .5), (0, 2.5, "E5", .5), (0, 3, "G5", 1),
           (1, 0, "F5", .5), (1, .5, "A5", .5), (1, 1, "C6", 1), (1, 2, "A5", .5), (1, 2.5, "F5", .5), (1, 3, "A5", 1),
           (2, 0, "G5", .5), (2, .5, "B5", .5), (2, 1, "D6", 1), (2, 2, "B5", .5), (2, 2.5, "G5", .5), (2, 3, "D6", 1),
           (3, 0, "C6", 1.5), (3, 1.5, "G5", .5), (3, 2, "E5", 1), (3, 3, "C5", 1),
           (4, 0, "A5", .5), (4, .5, "C6", .5), (4, 1, "E6", 1), (4, 2, "C6", .5), (4, 2.5, "A5", .5), (4, 3, "E5", 1),
           (5, 0, "F5", .5), (5, .5, "A5", .5), (5, 1, "C6", 1), (5, 2, "F6", 1), (5, 3, "C6", 1),
           (6, 0, "D6", .5), (6, .5, "B5", .5), (6, 1, "G5", .5), (6, 1.5, "B5", .5), (6, 2, "D6", 1), (6, 3, "F6", 1),
           (7, 0, "G6", 1), (7, 1, "F6", .5), (7, 1.5, "D6", .5), (7, 2, "B5", 1), (7, 3, "G5", 1)]
    for t, n, d in bars(bpm, mel):
        m.add(square(n, d * 0.92, 0.25), t, 0.22, pan=0.1)


# ---------- 音效 ----------
def win_fanfare(m):
    for i, n in enumerate(["G4", "C5", "E5", "G5"]):
        m.add(brass(n, 0.16), i * 0.11, 0.5)
    for n in ["C5", "E5", "G5", "C6"]:
        m.add(brass(n, 1.0, vib=0.006), 0.46, 0.35)
    for i, n in enumerate(["C7", "G6", "E7", "C7", "G7"]):
        m.add(bell(n, 0.8, 0.3), 0.5 + i * 0.12, 0.12)


def win_coins(m):
    for t in [0, 0.22, 0.44]:
        m.add(square("B5", 0.07, 0.5), t, 0.5)
        m.add(square("E6", 0.4, 0.5, decay=0.15), t + 0.07, 0.5)
    for i, n in enumerate(["E7", "B6", "G#7"]):
        m.add(bell(n, 0.6, 0.25), 0.7 + i * 0.07, 0.15)


def win_gong(m):   # 锣鼓：咚、咚、锵
    m.add(drum(1.0), 0); m.add(drum(0.9), 0.24)
    m.add(drum(0.8), 0.48); m.add(gong(1.6, 0.9), 0.48)


def lose_wahwah(m):
    for i, n in enumerate(["G4", "F#4", "F4"]):
        m.add(brass(n, 0.38), i * 0.42, 0.5)
    m.add(brass("E4", 1.1, vib=0.02), 1.26, 0.5)


def lose_slide(m):
    t = secs(0.8)
    f = 180 + 520 * np.exp(-t / 0.22)
    m.add(additive(f, 0.8, [(1, 1, None), (2, 0.25, None), (3, 0.08, None)], vib=0.02, vib_rate=9, vib_delay=0.3)
          * np.exp(-t / 0.5), 0, 0.6)


def draw_dingdong(m):
    m.add(bell("E5", 1.2, 0.7), 0, 0.6)
    m.add(bell("C5", 1.4, 0.8), 0.38, 0.6)


def draw_boop(m):
    for at in [0, 0.17]:
        t = secs(0.14)
        f = 320 + 380 * (1 - np.exp(-t / 0.03))
        m.add(additive(f, 0.14, [(1, 1, 0.06), (2, 0.2, 0.03)]), at, 0.7)


def photo_shutter(m):
    m.add(highpass(noise(0.012), 2500) * np.exp(-secs(0.012) / 0.003), 0, 0.5)
    m.add(additive(2100, 0.03, [(1, 1, 0.006)]), 0, 0.3)
    m.add(highpass(noise(0.03), 900) * np.exp(-secs(0.03) / 0.008), 0.075, 0.8)
    m.add(additive(120, 0.06, [(1, 1, 0.015)]), 0.075, 0.5)


def photo_flash(m):
    t = secs(0.15)
    m.add(additive(90 + 200 * np.exp(-t / 0.02), 0.15, [(1, 1, 0.04)]) + highpass(noise(0.15), 3000) * 0.3 * np.exp(-t / 0.02), 0, 0.7)
    for i, n in enumerate(["C7", "E7", "G7", "C8"]):
        m.add(bell(n, 0.7, 0.25), 0.08 + i * 0.035, 0.18)


if __name__ == "__main__":
    tracks = {
        "bgm-sunny": (19.2, bgm_sunny), "bgm-teahouse": (8 * 4 * 60 / 72, bgm_teahouse), "bgm-lofi": (8 * 4 * 60 / 82, bgm_lofi),
        "game-bouncy": (8 * 4 * 60 / 128, game_bouncy), "game-8bit": (8 * 4 * 60 / 150, game_8bit),
    }
    effects = {
        "win-fanfare": (2.0, win_fanfare), "win-coins": (1.4, win_coins), "win-gong": (2.3, win_gong),
        "lose-wahwah": (2.6, lose_wahwah), "lose-slide": (1.0, lose_slide),
        "draw-dingdong": (1.6, draw_dingdong), "draw-boop": (0.5, draw_boop),
        "photo-shutter": (0.35, photo_shutter), "photo-flash": (0.9, photo_flash),
    }
    only = sys.argv[1:]
    for name, (dur, fn) in tracks.items():
        if not only or name in only: music(name, dur, fn)
    for name, (dur, fn) in effects.items():
        if not only or name in only: sfx(name, dur, fn)
