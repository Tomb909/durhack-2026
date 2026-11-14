// All open water (sea, lakes, rivers) is one surface, lifted to the water
// level texture and drawn only where it is above the ground.
import * as THREE from 'three';
import { GH, GW } from '../sim/world';
import { GLSL_COMMON, WORLD_D, WORLD_W, type SharedUniforms } from './common';

const vertex = /* glsl */ `
${GLSL_COMMON}
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vec2 uv = tableUv(position.xz);
  float surface = fieldB(uv).r;
  vec3 p = vec3(position.x, surface * HSCALE, position.z);
  vUv = uv;
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const fragment = /* glsl */ `
${GLSL_COMMON}
varying vec2 vUv;
varying vec3 vWorld;

void main() {
  vec4 a = fieldA(vUv);
  vec4 b = fieldB(vUv);
  float depth = b.r - a.r;
  if (depth < 0.0002) discard;
  float temperature = a.g;
  float river = b.g;
  float rain = b.b;

  // Ripples: two layers of drifting noise give the normal.
  vec2 p = vWorld.xz;
  float t = uTime;
  float n1 = vnoise(p * 5.0 + vec2(t * 0.35, t * 0.22));
  float n2 = vnoise(p * 11.0 - vec2(t * 0.30, -t * 0.41));
  float n1x = vnoise(p * 5.0 + vec2(0.12, 0.0) + vec2(t * 0.35, t * 0.22));
  float n1z = vnoise(p * 5.0 + vec2(0.0, 0.12) + vec2(t * 0.35, t * 0.22));
  float n2x = vnoise(p * 11.0 + vec2(0.06, 0.0) - vec2(t * 0.30, -t * 0.41));
  float n2z = vnoise(p * 11.0 + vec2(0.0, 0.06) - vec2(t * 0.30, -t * 0.41));
  vec3 n = normalize(vec3((n1 - n1x) * 1.6 + (n2 - n2x) * 1.2, 1.0, (n1 - n1z) * 1.6 + (n2 - n2z) * 1.2));

  float frozen = smoothstep(uFreezing + 0.06, uFreezing - 0.10, temperature + (n1 - 0.5) * 0.10);

  float deep = smoothstep(0.0, 0.055, depth);
  vec3 shallowCol = vec3(0.16, 0.62, 0.66);
  vec3 deepCol = vec3(0.02, 0.17, 0.38);
  vec3 col = mix(shallowCol, deepCol, deep);
  col = mix(col, vec3(0.10, 0.42, 0.72), river * (1.0 - deep) * 0.85);

  vec3 view = normalize(cameraPosition - vWorld);
  float fresnel = pow(1.0 - max(dot(n, view), 0.0), 4.0);
  vec3 skyCol = mix(vec3(0.55, 0.72, 0.95), vec3(0.50, 0.55, 0.62), rain);
  col = mix(col, skyCol, 0.10 + 0.55 * fresnel);

  float overcast = 1.0 - 0.38 * rain;
  float ndl = max(dot(n, uSunDir), 0.0);
  col *= (0.55 + 0.75 * ndl * overcast);
  float spec = pow(max(dot(reflect(-uSunDir, n), view), 0.0), 90.0);
  col += vec3(1.0, 0.95, 0.85) * spec * 1.6 * overcast * (1.0 - frozen);

  // Foam where the water meets the land, breathing in and out.
  float lap = 0.0016 + 0.0009 * sin(t * 1.3 + p.x * 3.0 + p.y * 2.0);
  float foam = (1.0 - smoothstep(0.0, lap + 0.0016, depth)) * smoothstep(0.35, 0.65, n2 + 0.25);
  foam += (1.0 - smoothstep(0.0, 0.0009, depth)) * 0.8;
  col = mix(col, vec3(0.95, 0.98, 1.0), clamp(foam, 0.0, 1.0) * 0.85 * (1.0 - frozen) * (1.0 - smoothstep(0.05, 0.4, river)));
  // Rain rings.
  float ring = smoothstep(0.80, 0.98, vnoise(p * 26.0 + floor(t * 6.0) * 7.3)) * rain;
  col += ring * 0.10 * (1.0 - frozen);

  // Ice: pale, matte, with cracks.
  float crack = smoothstep(0.47, 0.5, abs(vnoise(p * 7.0) - 0.5) * 2.0 + 0.45) ;
  vec3 ice = mix(vec3(0.80, 0.90, 0.97), vec3(0.93, 0.97, 1.0), n2) * (0.72 + 0.45 * ndl * overcast);
  ice = mix(ice * 0.86, ice, crack);
  col = mix(col, ice, frozen);

  float alpha = mix(0.62, 0.95, max(deep, river * 0.8));
  alpha = mix(alpha, 0.97, frozen);
  alpha *= smoothstep(0.0002, 0.0016, depth);
  gl_FragColor = vec4(col, alpha);
}
`;

export function makeWater(shared: SharedUniforms): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(WORLD_W, WORLD_D, (GW - 1) * 2, (GH - 1) * 2);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.ShaderMaterial({
    uniforms: { ...shared },
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return mesh;
}
