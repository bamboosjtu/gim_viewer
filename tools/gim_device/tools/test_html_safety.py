"""Exercise the real viewer DOM with model text containing HTML payloads."""
from pathlib import Path

from playwright.sync_api import sync_playwright


def main():
    shell = Path(__file__).resolve().parents[1] / 'viewer_shell.html'
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            channel='msedge',
            args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                  '--allow-file-access-from-files'],
        )
        try:
            page = browser.new_page()
            page.goto(shell.as_uri())
            page.wait_for_function('window.__ready === true')
            result = page.evaluate('''() => {
              const text = '<img src=x onerror="window.__injected=true">';
              const type = 'bad" onmouseover="window.__injected=true';
              const entity = {id:1, type, part:text, mod:'x.mod', attrs:{note:text}};
              MODEL = {entities:[entity]};
              buildList();
              renderDetail(entity);
              return {
                images: document.querySelectorAll('#list img, #detail img').length,
                handlers: document.querySelectorAll('#list [onmouseover], #detail [onerror]').length,
                detailText: document.getElementById('detail').textContent,
                partText: document.querySelector('#list .grp').textContent,
                type: document.querySelector('#list .item').dataset.type,
                injected: !!window.__injected,
              };
            }''')
            assert result['images'] == result['handlers'] == 0, result
            assert result['injected'] is False, result
            assert '<img src=x onerror=' in result['detailText'], result
            assert '<img src=x onerror=' in result['partText'], result
            assert result['type'].startswith('bad" onmouseover='), result
            print('PASS: model text stays literal in the actual viewer DOM')
        finally:
            browser.close()


if __name__ == '__main__':
    main()
