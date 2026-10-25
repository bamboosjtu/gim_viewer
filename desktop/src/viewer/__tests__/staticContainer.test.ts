import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { freezeContainerLocalMatrix } from '../staticContainer.js';

describe('fixed scene/layer local transforms', () => {
  function fixture() {
    const scene = new THREE.Scene(), layer = new THREE.Group();
    const placement = new THREE.Group(), mesh = new THREE.Mesh(new THREE.BoxGeometry());
    placement.matrixAutoUpdate = mesh.matrixAutoUpdate = false;
    placement.matrix.makeTranslation(2, 3, 4);
    mesh.matrix.makeScale(-2, 3, 1);
    scene.add(layer); layer.add(placement); placement.add(mesh);
    freezeContainerLocalMatrix(scene); freezeContainerLocalMatrix(layer);
    scene.updateMatrixWorld();
    return { scene, layer, placement, mesh };
  }

  it('does not repeat static descendant world products in unchanged frames', () => {
    const { scene, mesh } = fixture();
    const multiply = vi.spyOn(mesh.matrixWorld, 'multiplyMatrices');
    for (let i = 0; i < 10; i++) scene.updateMatrixWorld();
    expect(multiply).not.toHaveBeenCalled();
  });

  it('keeps moving children, newly attached placements and explicit anchor updates correct', () => {
    const { scene, layer, placement, mesh } = fixture();
    const dynamic = new THREE.Group(); layer.add(dynamic);
    dynamic.position.set(5, 6, 7); scene.updateMatrixWorld();
    expect(dynamic.matrixWorld.elements.slice(12, 15)).toEqual([5, 6, 7]);
    dynamic.position.set(8, 9, 10); scene.updateMatrixWorld();
    expect(dynamic.matrixWorld.elements.slice(12, 15)).toEqual([8, 9, 10]);
    // Coordinate-anchor refresh uses the existing explicit forced update.
    placement.matrix.makeTranslation(20, 30, 40); placement.updateMatrixWorld(true);
    scene.updateMatrixWorld();
    expect(mesh.matrixWorld.elements.slice(12, 15)).toEqual([20, 30, 40]);
    expect(mesh.matrixWorld.determinant()).toBe(-6);
    const parent = new THREE.Group(); parent.position.x = 100;
    scene.add(parent); parent.add(placement); scene.updateMatrixWorld();
    expect(mesh.matrixWorld.elements.slice(12, 15)).toEqual([120, 30, 40]);
  });

  it('preserves a supplied affine local matrix and supports an explicit container edit', () => {
    const { scene, layer, mesh } = fixture();
    layer.matrix.makeTranslation(10, 0, 0); layer.matrix.elements[4] = 0.25;
    freezeContainerLocalMatrix(layer); // Must not overwrite an already manual matrix.
    layer.updateMatrixWorld(true); scene.updateMatrixWorld();
    expect(mesh.matrixWorld.elements.slice(12, 15)).toEqual([12.75, 3, 4]);
    scene.position.y = 100; scene.updateMatrix(); scene.updateMatrixWorld();
    expect(mesh.matrixWorld.elements.slice(12, 15)).toEqual([12.75, 103, 4]);
  });
});
