import * as THREE from 'three'

export function planeMaterial(map: THREE.Texture) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: true,
    uniforms: { map: { value: map } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D map;
      varying vec2 vUv;
      void main() {
        vec3 rgb = texture2D(map, vUv).rgb;
        float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
        luma = clamp((luma - 0.5) * 1.2 + 0.52, 0.0, 1.0);
        gl_FragColor = vec4(vec3(luma), 1.0);
      }`,
  })
}
