export const GUTTER = 16
export const RAIL_WIDTH = 248
export const PANEL_WIDTH = 296
export const PILL_HEIGHT = 44
export const PILL_BOTTOM = 24
export const NARROW = 720

export type FreeRect = { left: number; right: number; top: number; bottom: number }

export function freeRect(width: number, height: number, panelOpen: boolean): FreeRect {
  if (width <= NARROW) return { left: 0, right: width, top: 0, bottom: height - PILL_HEIGHT - PILL_BOTTOM * 2 }
  return {
    left: GUTTER + RAIL_WIDTH + GUTTER,
    right: width - (panelOpen ? GUTTER + PANEL_WIDTH + GUTTER : GUTTER),
    top: GUTTER,
    bottom: height - PILL_HEIGHT - PILL_BOTTOM * 2,
  }
}

export function applyLayoutVars(root: HTMLElement) {
  root.style.setProperty('--rail-width', `${RAIL_WIDTH}px`)
  root.style.setProperty('--panel-width', `${PANEL_WIDTH}px`)
  root.style.setProperty('--pill-height', `${PILL_HEIGHT}px`)
  root.style.setProperty('--pill-bottom', `${PILL_BOTTOM}px`)
}
