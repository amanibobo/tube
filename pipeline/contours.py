"""Mask to simplified contour. Shared by the YOLO path and the SAM 3 Modal container, so it imports only cv2."""

import cv2
import numpy as np

MAX_POINTS = 48


def mask_contour(mask: np.ndarray) -> tuple[list[list[int]], list[int]] | None:
    """Largest outer contour of a binary mask, simplified to at most MAX_POINTS, plus its centroid."""
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    c = max(contours, key=cv2.contourArea)
    if cv2.contourArea(c) < 4:
        return None
    eps = 0.005 * cv2.arcLength(c, True)
    poly = cv2.approxPolyDP(c, eps, True)
    while len(poly) > MAX_POINTS:
        eps *= 1.5
        poly = cv2.approxPolyDP(c, eps, True)
    if len(poly) < 3:
        return None
    m = cv2.moments(c)
    centroid = [round(m["m10"] / m["m00"]), round(m["m01"] / m["m00"])]
    return poly.reshape(-1, 2).tolist(), centroid
