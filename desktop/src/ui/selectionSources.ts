import {shouldAutoShowProps} from './shell/viewerShell.js';

/** Source ambiguity is a browsing choice, never an implicit geometry join. */
export function showSelectionSources(message: string, choices: {label: string; choose: () => void}[], isCurrent: () => boolean): void {
  if (!isCurrent()) return;
  const body = document.getElementById('props-drawer-body'); if (!body) return;
  body.replaceChildren();
  const explanation = document.createElement('div'); explanation.className = 'props-empty'; explanation.textContent = message;
  body.append(explanation);
  for (const choice of choices) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'props-source-choice';
    button.textContent = choice.label;
    button.addEventListener('click', () => { if (isCurrent()) choice.choose(); });
    body.append(button);
  }
  if (shouldAutoShowProps()) document.getElementById('props-drawer')?.classList.remove('collapsed');
}
