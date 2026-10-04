# Builds ../tcxp-workbench.html from the engine, the app and the PostgreSQL snapshot.
import os
d = os.path.dirname(os.path.abspath(__file__)); root = os.path.join(d, '..')
r = lambda p: open(p, encoding='utf-8').read()
shell, core, app, snap = r(os.path.join(d, 'shell.html')), r(os.path.join(root, 'tcxp.js')), r(os.path.join(d, 'app.js')), r(os.path.join(root, 'snapshot.json'))
for name, s in [('core', core), ('app', app), ('snap', snap)]:
    assert '</script' not in s.lower(), name
out = shell.replace('/*CORE*/', core, 1).replace('/*SNAPSHOT*/', snap, 1).replace('/*APP*/', app, 1)
page = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        + out.replace('<div class="app">', '</head>\n<body>\n<div class="app">', 1) + '\n</body>\n</html>\n')
open(os.path.join(root, 'tcxp-workbench.html'), 'w', encoding='utf-8').write(page)
print('wrote tcxp-workbench.html', len(page), 'bytes')
