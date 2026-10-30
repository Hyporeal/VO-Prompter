"""Build beta/ (served at /beta/) from a development checkout of the app.

usage: python3 tools/make_beta.py <dev checkout> <version, e.g. 1.1.29>

The beta shares the main app's fonts, icons, speech model and vendor libraries (one level up), and its scripts,
videos and settings on each device (same site). It has its own service worker cache and can be installed as its
own app ("VO Beta")."""
import json, os, re, shutil, sys

dev, version = sys.argv[1], sys.argv[2]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
beta = os.path.join(root, 'beta')

def read(p): return open(os.path.join(dev, p), encoding='utf-8').read()
def edit(text, pairs, name):
    for a, b, n in pairs:
        c = text.count(a)
        if c != n: raise SystemExit(f'{name}: expected {n} of {a!r}, found {c}')
        text = text.replace(a, b)
    return text

shutil.rmtree(beta, ignore_errors=True)
os.makedirs(os.path.join(beta, 'js'))
out = {}
out['index.html'] = edit(read('index.html'), [
    ('url(fonts/', 'url(../fonts/', 4), ('href="icon-192.png"', 'href="../icon-192.png"', 2),
    ('href="THIRD_PARTY_LICENSES.txt"', 'href="../THIRD_PARTY_LICENSES.txt"', 1),
    ('<title>VO Prompter</title>', '<title>VO Prompter Beta</title>', 1),
    ('Removes all scripts, videos, settings and the speech model from this device', 'Removes all scripts, videos, settings and the speech model from this device (shared with the main VO Prompter app, so it clears that too)', 1),
], 'index.html')
for f in sorted(os.listdir(os.path.join(dev, 'js'))):
    if not f.endswith('.js'): continue
    t = read('js/' + f)
    if f == 'engines.js': t = edit(t, [("'models/vosk", "'../models/vosk", 1), ("'vendor/vosk.js'", "'../vendor/vosk.js'", 1)], f)
    elif f == 'piper.js': t = edit(t, [("'vendor/", "'../vendor/", 4)], f)
    elif f == 'parse.js': t = edit(t, [("'vendor/pdfjs/", "'../vendor/pdfjs/", 2)], f)
    elif f == 'app.js': t = re.sub(r"const VERSION = '[^']*';", f"const VERSION = '{version} beta';", t)
    if re.search(r"'(vendor|models|fonts)/", t): raise SystemExit(f'{f}: a path to shared files was not rewritten')
    out['js/' + f] = t
sw = read('sw.js')
sw = re.sub(r"const CACHE = '[^']*';", "const CACHE = 'vo-prompter-beta-v1';", sw)
sw = sw.replace('/^vo-prompter-v\\d+$/', '/^vo-prompter-beta-v\\d+$/')
for a in ["'vendor/", "'icon-192.png'", "'icon-512.png'", "'fonts/"]: sw = sw.replace(a, "'../" + a[1:])
out['sw.js'] = sw
out['capture-worklet.js'] = read('capture-worklet.js')
man = json.loads(read('manifest.webmanifest'))
man.update({'name': 'VO Prompter Beta', 'short_name': 'VO Beta', 'description': 'Test copy of VO Prompter with experimental changes.', 'id': './', 'start_url': './', 'scope': './', 'theme_color': '#3a1d1d'})
for ic in man.get('icons', []): ic['src'] = '../' + ic['src']
out['manifest.webmanifest'] = json.dumps(man, indent=2) + '\n'
for p, t in out.items():
    with open(os.path.join(beta, p), 'w', encoding='utf-8') as fh: fh.write(t)
print('beta', version, 'built:', ', '.join(sorted(out)))
