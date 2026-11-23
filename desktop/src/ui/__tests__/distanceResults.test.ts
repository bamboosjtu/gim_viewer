import { expect, it, vi } from 'vitest';
import { initialToolState } from '../../shared/viewerCommands.js';
import { mountDistanceResults } from '../distanceResults.js';

it('renders the distance and two coordinate columns in the open drawer without exposing source metadata', async () => {
  document.body.innerHTML =
    '<div id="viewport"></div><aside id="props-drawer"><header id="props-drawer-header"><h3>对象属性</h3></header></aside>';
  const send = vi.fn(),
    view = mountDistanceResults(document.querySelector('#viewport')!, send);
  const state = initialToolState();
  state.tool = 'distance';
  state.distances = [
    {
      id: 1,
      a: { xyz: [1, 2, 3], source: 'private-file.ifc#19', lod: 'L0' },
      b: { xyz: [4, 6, 3], source: 'internal-part.dev', lod: 'L2' },
      metres: 5,
    },
  ];
  view.render(state);
  const drawer = document.querySelector('#props-drawer')!;
  const panel = drawer.querySelector('.viewer-distance-results')!;
  expect(panel.querySelector('.measure-value b')?.textContent).toBe('5.000');
  expect(
    [...panel.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.children].map((td) => td.textContent),
    ),
  ).toEqual([
    ['X', '1.000', '4.000'],
    ['Y', '2.000', '6.000'],
    ['Z', '3.000', '3.000'],
  ]);
  expect(panel.innerHTML).not.toMatch(/private-file|internal-part|L0|L2|来源/);
  drawer.classList.add('collapsed');
  await vi.waitFor(() => expect(panel.parentElement?.id).toBe('viewport'));
  view.dispose();
  expect(drawer.querySelector('h3')?.textContent).toBe('对象属性');
});
