import { describe, expect, it } from 'vitest';
import { CameraRig, DEFAULT_ELEVATION } from './camera';

/** Run the rig for a while so its easing has finished. */
function settle(rig: CameraRig, sway = 0, from = 0) {
  let pose = rig.step(sway, from);
  for (let i = 1; i <= 200; i++) pose = rig.step(sway, from + i * 0.05);
  return pose;
}

describe('the camera rig', () => {
  it('sits exactly at rest until touched, and follows the sway', () => {
    const rig = new CameraRig();
    expect(rig.step(0, 1)).toEqual({ azimuth: 0, elevation: DEFAULT_ELEVATION, zoom: 1, panX: 0, panZ: 0 });
    expect(rig.moved).toBe(false);
    expect(settle(rig, 0.3).azimuth).toBeCloseTo(0.3, 3);
  });
  it('stops swaying the moment it is grabbed, without jumping', () => {
    const rig = new CameraRig();
    const before = settle(rig, 0.3).azimuth;
    rig.grab(); // a click
    expect(rig.moved).toBe(true);
    expect(settle(rig, -0.3, 20).azimuth).toBeCloseTo(before, 3); // the sway no longer moves it
  });
  it('turns with a drag and never goes under the table or over the top', () => {
    const rig = new CameraRig();
    rig.orbit(-100, 0);
    expect(settle(rig).azimuth).toBeGreaterThan(0.3); // dragged left: seen from the right
    rig.orbit(0, 100000);
    expect(settle(rig).elevation).toBeLessThan(Math.PI / 2);
    rig.orbit(0, -100000);
    expect(settle(rig).elevation).toBeGreaterThan(0);
  });
  it('zooms within limits and keeps the pointed-at ground in place', () => {
    const rig = new CameraRig();
    rig.zoomBy(2, { x: 2, z: 1 });
    const pose = settle(rig);
    expect(pose.zoom).toBeCloseTo(2);
    expect(pose.panX).toBeCloseTo(1); // halfway to the point: it stays under the pointer
    expect(pose.panZ).toBeCloseTo(0.5);
    rig.zoomBy(1000);
    expect(settle(rig).zoom).toBeLessThanOrEqual(6);
    rig.zoomBy(0.00001);
    expect(settle(rig).zoom).toBeGreaterThanOrEqual(0.6);
  });
  it('slides with the hand and cannot leave the world', () => {
    const rig = new CameraRig();
    rig.frameInfo(5, 3.5, 0.01);
    rig.pan(100, 0); // ground dragged right: the looked-at point moves left
    expect(settle(rig).panX).toBeCloseTo(-1);
    rig.pan(-1e6, 0);
    expect(settle(rig).panX).toBe(5);
  });
  it('resets to rest by the short way round, and sways again', () => {
    const rig = new CameraRig();
    rig.orbit(-3000, 40); // more than two full turns
    rig.zoomBy(3);
    settle(rig);
    rig.reset();
    expect(rig.moved).toBe(false);
    const first = rig.step(0, 100);
    expect(Math.abs(first.azimuth)).toBeLessThanOrEqual(Math.PI);
    expect(settle(rig, 0, 100)).toEqual({ azimuth: 0, elevation: DEFAULT_ELEVATION, zoom: 1, panX: 0, panZ: 0 });
  });
});
