import { Color, LinearSRGBColorSpace, ShaderMaterial, Texture, Vector2, Vector4 } from 'three'

export const BACKGROUND = '#050505'
const LILAC = /* glsl */ `const vec3 LILAC = vec3(0.86, 0.6, 0.97);`
const LUMA = /* glsl */ `float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }`

export const fadeUniform = { value: new Vector2(1e6, 2e6) }
/** 0 = idle archive, 1 = results showing: the plane dims and desaturates, heat shows as lilac bands. */
export const dimUniform = { value: 0 }
/** Dev-only switch so scripts/verify.mjs can compare a card's atlas mapping to its frame JPEG without the edge styling. */
export const rawCardsUniform = { value: 0 }

const planeVertex = /* glsl */ `
attribute vec2 aUv;
attribute float aHeat;
uniform vec2 uCell;
uniform float uBand;
varying vec2 vUv;
varying float vHeat;
varying float vDepth;

void main() {
  vUv = aUv + vec2(uv.x, 0.5 + (uv.y - 0.5) * uBand) * uCell;
  vHeat = aHeat;
  vec4 view = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
  vDepth = -view.z;
  gl_Position = projectionMatrix * view;
}
`

const planeFragment = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uBackground;
uniform vec2 uFade;
uniform float uDim;
varying vec2 vUv;
varying float vHeat;
varying float vDepth;
${LILAC}
${LUMA}

void main() {
  vec3 color = texture2D(uMap, vUv).rgb;
  float l = luma(color);
  vec3 dimmed = mix(color, vec3(l), 0.85) * 0.17;
  vec3 band = LILAC * (0.3 + 0.8 * l);
  color = mix(color, mix(dimmed, band, smoothstep(0.38, 0.85, vHeat)), uDim);
  gl_FragColor = vec4(mix(color, uBackground, 0.75 * smoothstep(uFade.x, uFade.y, vDepth)), 1.0);
}
`

// Colours pass through raw (no colour-space chunks) so rendered cells match the atlas JPEG pixel for pixel.
function background(): Color {
  return new Color().setStyle(BACKGROUND, LinearSRGBColorSpace)
}

export function planeMaterial(map: Texture, cell: Vector2, band: number): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: planeVertex,
    fragmentShader: planeFragment,
    uniforms: { uMap: { value: map }, uCell: { value: cell }, uBand: { value: band }, uFade: fadeUniform, uDim: dimUniform, uBackground: { value: background() } },
  })
}

const cardVertex = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const cardFragment = /* glsl */ `
uniform sampler2D uMap;
uniform vec4 uCell;
uniform vec2 uTexel;
uniform float uOpacity;
uniform float uRaw;
varying vec2 vLocal;
${LILAC}
${LUMA}

float tap(vec2 uv) {
  return luma(texture2D(uMap, clamp(uv, uCell.xy + 0.5 * uTexel, uCell.xy + uCell.zw - 0.5 * uTexel)).rgb);
}

// Stands in for a person-mask outline (SAM, not available yet): a Sobel edge over the cell's luminance.
// Swap this for a mask texture lookup when masks exist.
float outline(vec2 uv) {
  vec2 d = 1.25 * uTexel;
  float tl = tap(uv + vec2(-d.x, d.y)), t = tap(uv + vec2(0.0, d.y)), tr = tap(uv + d);
  float l = tap(uv - vec2(d.x, 0.0)), r = tap(uv + vec2(d.x, 0.0));
  float bl = tap(uv - d), b = tap(uv - vec2(0.0, d.y)), br = tap(uv + vec2(d.x, -d.y));
  vec2 g = vec2(tr + 2.0 * r + br - tl - 2.0 * l - bl, tl + 2.0 * t + tr - bl - 2.0 * b - br);
  return smoothstep(0.22, 0.7, length(g));
}

void main() {
  vec2 uv = uCell.xy + vLocal * uCell.zw;
  vec3 raw = texture2D(uMap, uv).rgb;
  vec3 styled = vec3(luma(raw) * 0.4) + LILAC * outline(uv);
  gl_FragColor = vec4(mix(styled, raw, uRaw), uOpacity * mix(0.86, 1.0, uRaw));
}
`

export function cardMaterial(map: Texture, cell: Vector4, texel: Vector2): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: cardVertex,
    fragmentShader: cardFragment,
    transparent: true,
    depthWrite: false,
    uniforms: { uMap: { value: map }, uCell: { value: cell }, uTexel: { value: texel }, uOpacity: { value: 0 }, uRaw: rawCardsUniform },
  })
}

const dotVertex = /* glsl */ `
attribute float aAlpha;
uniform float uSize;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize;
}
`

const dotFragment = /* glsl */ `
uniform float uRing;
varying float vAlpha;
${LILAC}
void main() {
  float r = 2.0 * length(gl_PointCoord - 0.5);
  float a = uRing > 0.5 ? smoothstep(0.45, 0.62, r) * (1.0 - smoothstep(0.82, 1.0, r)) : 1.0 - smoothstep(0.5, 1.0, r);
  if (a * vAlpha <= 0.01) discard;
  gl_FragColor = vec4(LILAC, a * vAlpha);
}
`

/** Screen-sized round dots (connectors) or rings (markers on the plane); sizes in device pixels. */
export function dotMaterial(size: number, ring: boolean): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: dotVertex,
    fragmentShader: dotFragment,
    transparent: true,
    depthWrite: false,
    uniforms: { uSize: { value: size }, uRing: { value: ring ? 1 : 0 } },
  })
}

const markFragment = /* glsl */ `
${LILAC}
void main() { gl_FragColor = vec4(LILAC, 1.0); }
`

/** Flat lilac, raw like the rest of the plane: the bar under the viewer's own films. */
export function markMaterial(): ShaderMaterial {
  return new ShaderMaterial({ vertexShader: cardVertex, fragmentShader: markFragment })
}
