// The void around the world: a dark gradient dome and slow drifting motes.
import * as THREE from 'three';

export function makeBackdrop(time: THREE.IUniform<number>): THREE.Group {
  const group = new THREE.Group();

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(90, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          float h = vDir.y;
          vec3 deep = vec3(0.006, 0.008, 0.016);
          vec3 haze = vec3(0.022, 0.032, 0.070);
          vec3 col = mix(haze, deep, smoothstep(-0.25, 0.75, h));
          col = mix(col, vec3(0.012, 0.010, 0.022), smoothstep(-0.2, -0.9, h));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  dome.renderOrder = -10;
  group.add(dome);

  const count = 700;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 46;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 26;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 46 - 6;
    seeds[i] = Math.random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  const motes = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: { uTime: time },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        varying float vTwinkle;
        void main() {
          vec3 p = position;
          p.y = mod(p.y + uTime * (0.05 + 0.12 * aSeed) + 13.0, 26.0) - 13.0;
          p.x += 0.4 * sin(uTime * 0.2 + aSeed * 40.0);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vTwinkle = 0.55 + 0.45 * sin(uTime * (0.6 + aSeed) + aSeed * 90.0);
          gl_PointSize = (2.0 + 5.0 * aSeed) * 14.0 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vTwinkle;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vec3(0.55, 0.68, 1.0) * a * vTwinkle * 0.55, a);
        }
      `,
    }),
  );
  motes.frustumCulled = false;
  motes.renderOrder = -5;
  group.add(motes);
  return group;
}
