"""
Reference HDR(PQ/BT.2020)->SDR(BT.709/sRGB) conversion, built from public-domain
color-science formulas (SMPTE ST 2084 PQ EOTF, ITU-R BT.2087 BT.2020->BT.709
primaries matrix, John Hable's "Uncharted 2" filmic tonemap operator used
internally by ffmpeg's own tonemap=hable filter). Used here as an independent
ground-truth reference because this ffmpeg build lacks libzimg (no `zscale`
filter) to run the canonical `zscale=t=linear,tonemap=hable,zscale=t=bt709`
chain directly.

Produces three outputs from the same raw PQ/BT.2020 16-bit source frame:
  1. ref_hable_tonemap.png   -- proper filmic tonemap (npl=100) -> bt709/srgb
  2. ref_linear_clip.png     -- correct gamut+EOTF conversion, NO tonemap curve
                                 (hard-clip highlights > 1.0) -> bt709/srgb
  3. (byte-relabel baseline is produced separately via plain ffmpeg -pix_fmt)
"""
import numpy as np
from PIL import Image

SRC = "raw_pq_bt2020_frame36.raw"
W_, H_ = 1280, 720

# ---- Load raw PQ-encoded, BT.2020-primaries, full-range RGB48 (big-endian u16) ----
arr = np.fromfile(SRC, dtype=">u2").reshape(H_, W_, 3).astype(np.float64) / 65535.0

# ---- SMPTE ST 2084 (PQ) inverse EOTF: code value -> linear light ----
# L is fraction of 10000 nits (i.e., L=1.0 == 10000 nits)
m1 = 2610.0 / 16384.0
m2 = 2523.0 / 4096.0 * 128.0
c1 = 3424.0 / 4096.0
c2 = 2413.0 / 4096.0 * 32.0
c3 = 2392.0 / 4096.0 * 32.0


def pq_eotf(e):
    e_p = np.power(np.clip(e, 0, 1), 1.0 / m2)
    num = np.clip(e_p - c1, 0, None)
    den = c2 - c3 * e_p
    l = np.power(num / den, 1.0 / m1)
    return l


L_2020 = pq_eotf(arr)  # linear, BT.2020 primaries, fraction-of-10000-nits

# ---- BT.2020 (linear) -> BT.709 (linear) primaries matrix (D65->D65) ----
# Standard published coefficients (ITU-R BT.2087 / common derivation).
M = np.array(
    [
        [1.6605, -0.5876, -0.0728],
        [-0.1246, 1.1329, -0.0083],
        [-0.0182, -0.1006, 1.1187],
    ]
)
L_709 = L_2020 @ M.T  # still fraction-of-10000-nits, now BT.709 primaries

# ---- npl=100 normalization: rescale so 100 nits (SDR reference white) = 1.0 ----
L_norm = L_709 * (10000.0 / 100.0)


# ---- Variant A: Hable ("Uncharted 2") filmic tonemap, matches ffmpeg tonemap=hable ----
def hable_curve(x):
    A, B, C, D, E, F = 0.15, 0.50, 0.10, 0.20, 0.02, 0.30
    return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F


W = 11.2
white_scale = 1.0 / hable_curve(np.array([W]))[0]


def hable_tonemap(x):
    return np.clip(hable_curve(np.clip(x, 0, None)) * white_scale, 0, 1)


tonemapped = hable_tonemap(L_norm)

# ---- Variant B: correct gamut/EOTF conversion, but NO tonemap curve (hard clip) ----
clipped = np.clip(L_norm, 0, 1)


# ---- sRGB OETF (linear -> display code value); close approximation of BT.709 OETF,
#      and IS exactly what canvas colorSpace:"srgb" expects ----
def srgb_oetf(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)


out_tonemap = (srgb_oetf(tonemapped) * 255).round().astype(np.uint8)
out_clip = (srgb_oetf(clipped) * 255).round().astype(np.uint8)

Image.fromarray(out_tonemap, "RGB").save("ref_hable_tonemap.png")
Image.fromarray(out_clip, "RGB").save("ref_linear_clip.png")

# ---- Stats for signalstats-style comparison ----
def luma_stats(rgb8, label):
    r, g, b = rgb8[..., 0].astype(np.float64), rgb8[..., 1].astype(np.float64), rgb8[..., 2].astype(np.float64)
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b  # bt709 luma weights
    print(f"{label}: mean_luma={y.mean():.2f} std_luma={y.std():.2f} "
          f"mean_r={r.mean():.1f} mean_g={g.mean():.1f} mean_b={b.mean():.1f} "
          f"p99_luma={np.percentile(y,99):.1f} max_luma={y.max():.1f}")


luma_stats(out_tonemap, "ref_hable_tonemap")
luma_stats(out_clip, "ref_linear_clip")
print("done")
