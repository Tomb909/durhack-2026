// Shows which part of the world each card is acting on: a soft pillar of light
// and a ring on the ground in the world itself, and a crisp label above.
//
// The labels are ordinary page elements placed over the picture, not part of
// the 3D scene, so the tilt-shift blur never touches them. Copies of the same
// card that sit close together share one label ("WATER ×3"), and labels that
// would collide on screen are stacked instead.
import * as THREE from 'three';
import { modifierTargets } from '../cards/modifiers';
import type { LiveCard } from '../cards/store';
import { sampleField, type WorldFrame } from '../sim/world';
import { HSCALE, world } from './common';

const LABEL_HEIGHT = 3.5; // scene units above the base of the world
const GROUP_RADIUS = 0.14; // copies closer than this (fraction of the world's width) share a label
const LABEL_GAP = 5; // pixels kept clear between stacked labels

function titleCase(word: string): string {
  return word.charAt(0) + word.slice(1).toLowerCase();
}

/**
 * Copies of the same card that sit close together, as groups (each shares one label).
 * A card that lands between two groups joins them into one. `skip` cards get no label of their own.
 */
export function groupCopies(cards: LiveCard[], skip: ReadonlySet<LiveCard>, aspect: number): LiveCard[][] {
  const groups: LiveCard[][] = [];
  for (const card of cards) {
    if (skip.has(card)) continue;
    let home: LiveCard[] | undefined;
    for (const group of groups) {
      // A group emptied by an earlier join has no first card to compare with.
      if (!group.length || group[0].def !== card.def) continue;
      if (group.some((other) => Math.hypot(other.x - card.x, (other.y - card.y) / aspect) < GROUP_RADIUS)) {
        if (home) {
          home.push(...group);
          group.length = 0;
        } else {
          home = group;
        }
      }
    }
    if (home) home.push(card);
    else groups.push([card]);
  }
  return groups.filter((group) => group.length > 0);
}

interface Mark {
  beam: THREE.Mesh;
  ring: THREE.Mesh;
}

interface Label {
  el: HTMLElement;
  text: string;
  width: number;
  height: number;
  lift: number; // pixels raised to avoid a neighbour (eased)
  x: number;
  y: number;
}

export class Beacons {
  readonly group = new THREE.Group();
  private marks = new Map<string, Mark>();
  private labels = new Map<string, Label>();
  private beamGeometry = new THREE.CylinderGeometry(0.035, 0.035, 1, 8, 1, true).translate(0, 0.5, 0);
  private ringGeometry = new THREE.RingGeometry(0.16, 0.22, 40).rotateX(-Math.PI / 2);
  private point = new THREE.Vector3();

  constructor(private layer: HTMLElement) {}

  private makeMark(card: LiveCard): Mark {
    const glow = {
      color: new THREE.Color(card.def.color), transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    };
    const beam = new THREE.Mesh(this.beamGeometry, new THREE.MeshBasicMaterial(glow));
    beam.renderOrder = 10;
    const ring = new THREE.Mesh(this.ringGeometry, new THREE.MeshBasicMaterial({ ...glow, depthTest: false }));
    ring.renderOrder = 11;
    this.group.add(beam, ring);
    return { beam, ring };
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    this.layer.style.display = visible ? '' : 'none';
  }

  /** Call every frame after the camera has been placed. */
  update(cards: LiveCard[], frame: WorldFrame, time: number, camera: THREE.Camera, width: number, height: number): void {
    const modifiersByTarget = modifierTargets(cards);
    const attachedModifiers = new Set([...modifiersByTarget.values()].flat());

    // --- pillars and rings, one per physical card
    const ground = new Map<LiveCard, number>();
    const seen = new Set<string>();
    for (const card of cards) {
      seen.add(card.key);
      let mark = this.marks.get(card.key);
      if (!mark) {
        mark = this.makeMark(card);
        this.marks.set(card.key, mark);
      }
      const g = Math.max(sampleField(frame.height, frame.w, frame.h, card.x, card.y), sampleField(frame.waterSurface, frame.w, frame.h, card.x, card.y)) * HSCALE;
      ground.set(card, g);
      const top = Math.max(LABEL_HEIGHT, g + 1.3);
      const x = (card.x - 0.5) * world.w;
      const z = (card.y - 0.5) * world.d;
      mark.beam.position.set(x, g, z);
      mark.beam.scale.set(1, Math.max(0.01, top - g), 1);
      const pulse = 1 + 0.12 * Math.sin(time * 2.2 + card.y * 7);
      mark.ring.position.set(x, g + 0.03, z);
      mark.ring.scale.set(pulse, 1, pulse);
      const held = card.visible ? 1 : 0.45;
      (mark.beam.material as THREE.MeshBasicMaterial).opacity = 0.3 * card.strength * held;
      (mark.ring.material as THREE.MeshBasicMaterial).opacity = 0.55 * card.strength * held;
    }
    for (const [key, mark] of this.marks) {
      if (!seen.has(key)) {
        this.group.remove(mark.beam, mark.ring);
        (mark.beam.material as THREE.Material).dispose();
        (mark.ring.material as THREE.Material).dispose();
        this.marks.delete(key);
      }
    }

    // --- group nearby copies of the same card; attached modifiers share the target label
    const groups = groupCopies(cards, attachedModifiers, world.aspect);

    // --- one label per group
    const live = new Set<string>();
    const placed: Label[] = [];
    const entries = groups
      .map((group) => ({ group, key: `${group[0].def.id}:${group.map((c) => c.key).sort()[0]}` }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    for (const { group, key } of entries) {
      live.add(key);
      let weight = 0;
      let x = 0;
      let y = 0;
      let top = LABEL_HEIGHT;
      let strength = 0;
      let anyVisible = false;
      for (const card of group) {
        const w = Math.max(card.strength, 0.001);
        weight += w;
        x += card.x * w;
        y += card.y * w;
        top = Math.max(top, (ground.get(card) ?? 0) + 1.3);
        strength = Math.max(strength, card.strength);
        anyVisible ||= card.visible;
      }
      x /= weight;
      y /= weight;
      const count = group.filter((c) => c.present).length || group.length;
      const def = group[0].def;
      const modifiers = group.flatMap((card) => modifiersByTarget.get(card) ?? []);
      const text = modifiers.length
        ? `${modifiers.map((modifier) => titleCase(modifier.def.word)).join(' ')} ${titleCase(def.word)}${count > 1 ? ` ×${count}` : ''}`
        : count > 1 ? `${def.word} ×${count}` : def.word;

      let label = this.labels.get(key);
      if (!label) {
        const el = document.createElement('div');
        el.className = 'world-label';
        el.style.setProperty('--c', def.color);
        el.innerHTML = `<span class="i">${def.icon}</span><span class="w"></span>`;
        this.layer.appendChild(el);
        label = { el, text: '', width: 0, height: 0, lift: 0, x: 0, y: 0 };
        this.labels.set(key, label);
      }
      if (label.text !== text) {
        label.text = text;
        (label.el.querySelector('.w') as HTMLElement).textContent = text;
        label.width = label.el.offsetWidth;
        label.height = label.el.offsetHeight;
      }

      this.point.set((x - 0.5) * world.w, top, (y - 0.5) * world.d).project(camera);
      label.x = (this.point.x * 0.5 + 0.5) * width;
      label.y = (-this.point.y * 0.5 + 0.5) * height;

      // Stack above any label already placed that this one would cover.
      let lift = 0;
      for (let tries = 0; tries < 8; tries++) {
        const clash = placed.find(
          (other) =>
            Math.abs(other.x - label!.x) < (other.width + label!.width) / 2 + LABEL_GAP &&
            Math.abs(other.y - other.lift - (label!.y - lift)) < (other.height + label!.height) / 2 + LABEL_GAP,
        );
        if (!clash) break;
        lift = label.y - (clash.y - clash.lift) + (clash.height + label.height) / 2 + LABEL_GAP;
      }
      label.lift += (lift - label.lift) * 0.18;
      placed.push(label);

      label.el.style.transform = `translate(${label.x.toFixed(1)}px, ${(label.y - label.lift).toFixed(1)}px) translate(-50%, -100%)`;
      label.el.style.opacity = String(strength * (anyVisible ? 1 : 0.5));
    }
    for (const [key, label] of this.labels) {
      if (!live.has(key)) {
        label.el.remove();
        this.labels.delete(key);
      }
    }
  }
}
