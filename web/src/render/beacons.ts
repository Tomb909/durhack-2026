// A soft pillar of light and an icon above each card's position, so it is
// obvious which part of the world a scrap on the table is acting on.
import * as THREE from 'three';
import type { LiveCard } from '../cards/store';
import { sampleField, type WorldFrame } from '../sim/world';
import { HSCALE, WORLD_D, WORLD_W } from './common';

const ICON_HEIGHT = 3.7;

interface Beacon {
  group: THREE.Group;
  icon: THREE.Sprite;
  beam: THREE.Mesh;
  ring: THREE.Mesh;
}

const iconCache = new Map<string, THREE.Texture>();

function iconTexture(icon: string, word: string, colour: string): THREE.Texture {
  const key = `${icon}|${word}|${colour}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const g = canvas.getContext('2d')!;
  g.beginPath();
  g.arc(128, 104, 84, 0, Math.PI * 2);
  g.fillStyle = 'rgba(12, 16, 26, 0.72)';
  g.fill();
  g.lineWidth = 8;
  g.strokeStyle = colour;
  g.stroke();
  g.font = '96px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(icon, 128, 110);
  g.font = '700 34px system-ui, sans-serif';
  g.fillStyle = '#ffffff';
  g.shadowColor = 'rgba(0,0,0,0.9)';
  g.shadowBlur = 8;
  g.fillText(word, 128, 226);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  iconCache.set(key, texture);
  return texture;
}

export class Beacons {
  readonly group = new THREE.Group();
  private beacons = new Map<string, Beacon>();
  private beamGeometry = new THREE.CylinderGeometry(0.035, 0.035, 1, 8, 1, true).translate(0, 0.5, 0);
  private ringGeometry = new THREE.RingGeometry(0.16, 0.22, 40).rotateX(-Math.PI / 2);

  private make(card: LiveCard): Beacon {
    const colour = new THREE.Color(card.def.color);
    const icon = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: iconTexture(card.def.icon, card.def.word, card.def.color), transparent: true, depthTest: false, depthWrite: false }),
    );
    icon.scale.set(0.95, 0.95, 1);
    icon.renderOrder = 20;
    const glow = { color: colour, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide };
    const beam = new THREE.Mesh(this.beamGeometry, new THREE.MeshBasicMaterial(glow));
    beam.renderOrder = 10;
    const ring = new THREE.Mesh(this.ringGeometry, new THREE.MeshBasicMaterial({ ...glow, depthTest: false }));
    ring.renderOrder = 11;
    const group = new THREE.Group();
    group.add(icon, beam, ring);
    this.group.add(group);
    return { group, icon, beam, ring };
  }

  update(cards: LiveCard[], frame: WorldFrame, time: number): void {
    const seen = new Set<string>();
    for (const card of cards) {
      seen.add(card.key);
      let beacon = this.beacons.get(card.key);
      if (!beacon) {
        beacon = this.make(card);
        this.beacons.set(card.key, beacon);
      }
      const ground = Math.max(sampleField(frame.height, card.x, card.y), sampleField(frame.waterSurface, card.x, card.y)) * HSCALE;
      const top = Math.max(ICON_HEIGHT, ground + 1.3);
      beacon.group.position.set((card.x - 0.5) * WORLD_W, 0, (card.y - 0.5) * WORLD_D);
      beacon.icon.position.y = top + 0.06 * Math.sin(time * 1.6 + card.x * 9);
      beacon.beam.position.y = ground;
      beacon.beam.scale.set(1, Math.max(0.01, top - 0.45 - ground), 1);
      beacon.ring.position.y = ground + 0.03;
      const pulse = 1 + 0.12 * Math.sin(time * 2.2 + card.y * 7);
      beacon.ring.scale.set(pulse, 1, pulse);
      const held = card.visible ? 1 : 0.45; // dimmer while the camera cannot see the scrap
      (beacon.icon.material as THREE.SpriteMaterial).opacity = card.strength * held;
      (beacon.beam.material as THREE.MeshBasicMaterial).opacity = 0.30 * card.strength * held;
      (beacon.ring.material as THREE.MeshBasicMaterial).opacity = 0.55 * card.strength * held;
    }
    for (const [key, beacon] of this.beacons) {
      if (!seen.has(key)) {
        this.group.remove(beacon.group);
        beacon.icon.material.dispose();
        (beacon.beam.material as THREE.Material).dispose();
        (beacon.ring.material as THREE.Material).dispose();
        this.beacons.delete(key);
      }
    }
  }
}
