"""Card tracking: find the play area, find ink, follow scraps, read words."""

# Geometry shared by every stage. The play area is treated as A3 landscape;
# "roughly A3" is fine because positions are reported as fractions of the area.
PLAY_W_MM = 420.0
PLAY_H_MM = 297.0
PX_PER_MM = 2.5
RECT_W = int(round(PLAY_W_MM * PX_PER_MM))  # 1050
RECT_H = int(round(PLAY_H_MM * PX_PER_MM))  # 742


def mm(value: float) -> int:
    """Millimetres on the table to pixels in the rectified image."""
    return max(1, int(round(value * PX_PER_MM)))


def odd(value: int) -> int:
    return value if value % 2 == 1 else value + 1
