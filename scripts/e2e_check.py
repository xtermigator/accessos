"""Optional headless check: walks the whole flow keyboard-only from file://, in full and simplified modes.
Needs: pip install playwright && python -m playwright install chromium
Run:   python3 scripts/e2e_check.py
"""
import sys, json, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = 'file://' + ROOT + '/index.html'
SHOTS = os.environ.get('SHOTS', '/tmp/accessos-shots')
import os; os.makedirs(SHOTS, exist_ok=True)

errors = []
def run(reduced, simple_mode, tag):
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 1280, 'height': 900}, reduced_motion='reduce' if reduced else 'no-preference')
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(f'{tag} pageerror: {e}'))
        pg.on('console', lambda m: errors.append(f'{tag} console.{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        pg.goto(URL)
        if simple_mode:
            pg.check('#simplify')
        def h1(): return pg.inner_text('#screen h1')
        def focused(): return pg.evaluate('document.activeElement && document.activeElement.tagName')
        steps = []
        def snap(name):
            steps.append((h1(), pg.inner_text('#progress'), focused()))
            pg.screenshot(path=f'{SHOTS}/{tag}-{len(steps):02d}-{name}.png', full_page=True)
        snap('need')
        # keyboard only: tab to the primary button and press Enter
        def press_primary():
            pg.focus('#screen button.primary'); pg.keyboard.press('Enter'); pg.wait_for_timeout(150)
        press_primary(); snap('plan')
        press_primary(); snap('shortlist')
        press_primary(); snap('compare')
        press_primary(); snap('approve')
        press_primary(); snap('recheck')
        press_primary(); snap('mandate')
        if not simple_mode:
            pg.click('text=Charge $5 more'); pg.click('text=Pay a different store'); pg.wait_for_timeout(150)
            guard = pg.inner_text('#guardout')
        else:
            guard = '(hidden in simple mode)'
        press_primary(); snap('done')
        logtxt = pg.inner_text('#log')
        b.close()
        return steps, guard, logtxt

for args in [(False, False, 'full'), (True, True, 'simple')]:
    steps, guard, logtxt = run(*args)
    print('=== ' + args[2])
    for s in steps: print(s)
    print('guard:', guard.replace('\n', ' | '))
    print('log:\n' + logtxt)
print('ERRORS:', errors or 'none')

sys.exit(1 if errors else 0)
